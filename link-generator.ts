import { open } from 'inspector';
import _, { map } from 'lodash';
import log from 'loglevel';
import { OpenAPIV3 } from 'openapi-types';
import { string } from 'yargs';
import { isExternalRef, resolveComponentRef, sanitizeComponentName, serializeJsonPointer } from './openapi-tools';

log.setDefaultLevel('error');

interface PotentialLink {
  // The from and to strings are paths in the OpenAPI document
  from: string;
  to: string;

}

interface Link extends PotentialLink {
  // Keys are parameters of the 'from' path and values are parameters of the 'to' path
  parameterMap: Map<OpenAPIV3.ParameterObject, OpenAPIV3.ParameterObject>;
}
function capitalizeFirstLetter(string: string): string {
  return string.charAt(0).toUpperCase() + string.slice(1);
}
/**
 * Find path-pairs where a link may potentially be added. We have such a pair if:
 * - Both paths have a get-request defined that has at least one successful response
 * - The to path is an extension of the from path (e.g. from=/path, to=/path/extension
 *   but not from=/path, to=/pathA)
 * @param openapi The OpenAPI document
 */


function findPotentialLinkPairs(openapi: OpenAPIV3.Document): PotentialLink[] {
  const result: PotentialLink[] = [];

  // Only keep paths that have a get definition that has at least one
  // successful response defined. (Successful meaning HTTP code 2xx)
  const getPaths = Object.keys(openapi.paths).filter(path => {
    const pO = openapi.paths[path].get;
    return (
      pO != null &&
      pO.responses != null &&
      Object.keys(pO.responses)
        .map(key => parseInt(key, 10))
        .some(code => !isNaN(code) && code >= 200 && code < 300)
    );
  });

  //console.log(getPaths);

  const postPaths = Object.keys(openapi.paths).filter(path => {
    const p1 = openapi.paths[path].post;
    return (
      p1 != null &&
      p1.responses != null &&
      Object.keys(p1.responses)
        .map(key => parseInt(key, 10))
        .some(code => !isNaN(code) && code >= 200 && code < 300)
    );
  });

  //console.log(postPaths);
  const deletePaths = Object.keys(openapi.paths).filter(path => {
    const p2 = openapi.paths[path].delete;
    return (
      p2 != null &&
      p2.responses != null &&
      Object.keys(p2.responses)
        .map(key => parseInt(key, 10))
        .some(code => !isNaN(code) && code >= 200 && code < 300)
    );
  });



  //get para post
  for (const path of getPaths) {

    for (const innerPostPath of postPaths) {
      if (
        path !== innerPostPath &&
        ((path.endsWith('/') && innerPostPath.startsWith(path)) || innerPostPath.startsWith(path + '/'))
      ) {
        //console.log("caminho get em questao: " + path);
        //console.log("caminho post selecionado: " + innerPostPath);
        result.push({
          from: path,
          to: innerPostPath
        });
      }
    }


    for (const innerDeletePath of deletePaths) {
      if (!postPaths.includes(innerDeletePath))
        if (
          path !== innerDeletePath &&
          ((path.endsWith('/') && innerDeletePath.startsWith(path)) || innerDeletePath.startsWith(path + '/'))
        ) {
          //console.log("caminho get em questao: " + path);
          //console.log("caminho post selecionado: " + innerPostPath);
          result.push({
            from: path,
            to: innerDeletePath
          });
        }

    }


    for (const innerGetPath of getPaths) {
      if (!postPaths.includes(innerGetPath)) {
        if (
          path !== innerGetPath &&
          ((path.endsWith('/') && innerGetPath.startsWith(path)) || innerGetPath.startsWith(path + '/'))
        ) {
          //console.log("caminho get em questao: " + path);
          //console.log("caminho get selecionado: " + innerGetPath);
          result.push({
            from: path,
            to: innerGetPath
          });
        }
      }
    }




  }

  log.debug(`Found ${result.length} potential link candidates`);

  return result;

}

/**
 * Takes a parameters array from the OpenAPI document and dereferences all the items.
 * @param openapi The OpenAPI document
 * @param parameters The parameters to be dereferenced
 */
function dereferenceParameters(
  openapi: OpenAPIV3.Document,
  parameters: Array<OpenAPIV3.ReferenceObject | OpenAPIV3.ParameterObject>
): OpenAPIV3.ParameterObject[] {
  return parameters.map(obj => {
    //console.log(obj);
    if ('$ref' in obj) {
      //console.log(obj);
      return resolveComponentRef(openapi, obj, 'parameters');
    } else {
      return obj;
    }
  });
}

/**
 * Check if two schema objects describe the same schema. This is done as follows:
 * If both schemas are references and contain the same URI, we consider them equal.
 * If exactly one schema is an external reference, we consider them not equal.
 * Otherwise, we derefence internal references and consider the schemas equal
 * if they contain the same properties with the same values.
 *
 * @param openapi The OpenAPI document
 * @param firstSchema The first schema or reference to check
 * @param secondSchema The second schema or reference to check
 */
function areSchemasMatching(
  openapi: OpenAPIV3.Document,
  firstSchema?: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
  secondSchema?: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject
): boolean {
  // If both schemas are undefined, we assume they are matching
  if (firstSchema == null && secondSchema == null) {
    return true;
  }
  // At this point, at most one schema can be undefined and the other is not
  if (firstSchema == null || secondSchema == null) {
    return false;
  }

  if ('$ref' in firstSchema && '$ref' in secondSchema) {
    // If we have two references, external or internal, we only check if they are equal
    return firstSchema.$ref === secondSchema.$ref;
  }

  // At this point at least one of the schemas is not a reference. If one is a reference
  // we require it to be internal because we currently do not parse external references.
  for (const param of [firstSchema, secondSchema]) {
    if ('$ref' in param && isExternalRef(param)) {
      return false;
    }
  }

  // Resolve the remaining internal schema references
  const first = '$ref' in firstSchema ? resolveComponentRef(openapi, firstSchema, 'schemas') : firstSchema;
  const second = '$ref' in secondSchema ? resolveComponentRef(openapi, secondSchema, 'schemas') : secondSchema;

  // Check if the schemas are equal
  return _.isEqual(first, second);
}

/**
 * Check if two parameter objects can be considered equal. To do that, we use a simple heuristic: *
 * We assume that parameters with the same name and same schema have identical meaning across different
 * operations. This heuristic is implemented in this function.
 *
 * @param openapi The OpenAPI document
 * @param firstParameter The first parameter to check
 * @param secondParameter The second parameter to check
 */
function areParametersMatching(
  openapi: OpenAPIV3.Document,
  firstParameter: OpenAPIV3.ParameterObject,
  secondParameter: OpenAPIV3.ParameterObject
): boolean {
  // Check if the names are equal
  if (firstParameter.name !== secondParameter.name) {
    return false;
  }

  // Check if the schemas are equal
  return areSchemasMatching(openapi, firstParameter.schema, secondParameter.schema);
}

/**
 * Filter the list of potential links by looking at the parameters.
 * To do this, we assume that parameters of different paths with same name and schema have the same meaning.
 *
 * If there is a required parameter of the 'to' path and the 'from' path does not have a matching parameter,
 * we discard this potential link. Otherwise we save the matching parameters in the parametersMap.
 * @param openapi The OpenAPI document
 * @param links An array of potential links
 */
function processLinkParameters(openapi: OpenAPIV3.Document, links: PotentialLink[]): Link[] {
  // Filter the potential links where the 'to' path requires parameters that are non-existent in the 'from' path
  const newLinks: Link[] = [];
  log.debug('Processing potential link candidates');

  //console.log(links);
  for (const link of links) {
    console.log("LINK");
    console.log(link);
    const fromPath = openapi.paths[link.from];
    const toPath = openapi.paths[link.to];

    //console.log("Caminhos to: " + toPath);

    const fromGet = fromPath.get as OpenAPIV3.OperationObject;

    if (toPath.hasOwnProperty('get') && toPath.hasOwnProperty('post') && toPath.hasOwnProperty('delete')) {
      console.log("POST, DELETE, GET");
      const toGet = toPath.get as OpenAPIV3.OperationObject;
      const toPost = toPath.post as OpenAPIV3.OperationObject;
      const toDelete = toPath.delete as OpenAPIV3.OperationObject;

      if (
        [...(toGet.parameters || []), ...(toPost.parameters || []), ...(toDelete.parameters || []), ...(toPath.parameters || [])].some(
          parameter => '$ref' in parameter && isExternalRef(parameter)
        )
      ) {

        log.debug(`  Dropping link candidate due to external parameter reference: '${link.from}' => '${link.to}'`);
      }
      else {
        // Create parameter lists incorporating the path and the operation parameters.
        // At this point, we know that there are no external references in the to-path. We filter out all
        // the external references from the from-path.
        const fromParams = dereferenceParameters(
          //dereferencing the get parameters
          openapi,
          (fromGet.parameters || []).filter(param => !('$ref' in param && isExternalRef(param)))
        );
        if (fromPath.parameters != null) {
          fromParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, fromPath.parameters).filter(param =>
              fromParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        const toParams = dereferenceParameters(openapi, toGet.parameters || []);
        console.log(toParams);
        if (toPath.parameters != null) {
          toParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, toPath.parameters).filter(param =>
              toParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        // Ignore cookie parameters as they are assumed to be automatically conveyed
        _.remove(toParams, parameter => parameter.in === 'cookie');
        _.remove(fromParams, parameter => parameter.in === 'cookie');

        // We use a simple heuristic: We assume that parameters with the same name and same schema have identical meaning
        // across different operations. Therefore, we filter the potential links where all parameters for the to-operation
        // are already given by the from operation.
        const parameterMap = new Map<OpenAPIV3.ParameterObject, OpenAPIV3.ParameterObject>();
        const valid = toParams.every(toParam => {
          // If both schema-definitions are null the equality check also succeeds
          const fromParam = fromParams.find(p => areParametersMatching(openapi, toParam, p));
          if (fromParam != null) {
            //console.log("entrou aqui no nao nullo");
            parameterMap.set(fromParam, toParam);

            let mapIter = parameterMap.keys();

            //console.log("Valor 1: ");
            //console.log(mapIter.next().value);

            let mapIter1 = parameterMap.values();

            //console.log("Valor 2: ");
            //console.log(mapIter1.next().value);

            let mapIter2 = parameterMap.values();

            //console.log("Valor 3: ");
            //console.log(mapIter2.next().value);
            return true;
          } else {
            // We have not found a matching from-parameter. However, we do not need one if the parameter is optional.
            //console.log("entrou aqui no nullo ou falso");
            return toParam.required == null || toParam.required === false;
          }
        });
        //console.log("valor de valid: " + valid);

        if (valid) {
          newLinks.push({
            ...link,
            parameterMap
          });
          log.debug(`  Valid link candidate found: '${link.from}' => '${link.to}', ${parameterMap.size} parameter(s)`);
        }
      }


    }
    else if (toPath.hasOwnProperty('get') && toPath.hasOwnProperty('post') && !toPath.hasOwnProperty('delete')) {
      console.log("GET e POST");
      const toGet = toPath.get as OpenAPIV3.OperationObject;
      const toPost = toPath.post as OpenAPIV3.OperationObject;

      if (
        [...(toGet.parameters || []), ...(toPost.parameters || []), ...(toPath.parameters || [])].some(
          parameter => '$ref' in parameter && isExternalRef(parameter)
        )
      ) {

        log.debug(`  Dropping link candidate due to external parameter reference: '${link.from}' => '${link.to}'`);
      }
      else {
        // Create parameter lists incorporating the path and the operation parameters.
        // At this point, we know that there are no external references in the to-path. We filter out all
        // the external references from the from-path.
        const fromParams = dereferenceParameters(
          //dereferencing the get parameters
          openapi,
          (fromGet.parameters || []).filter(param => !('$ref' in param && isExternalRef(param)))
        );
        if (fromPath.parameters != null) {
          fromParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, fromPath.parameters).filter(param =>
              fromParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        const toParams = dereferenceParameters(openapi, toGet.parameters && toPost.parameters || []);
        //console.log(toParams);
        if (toPath.parameters != null) {
          toParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, toPath.parameters).filter(param =>
              toParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        // Ignore cookie parameters as they are assumed to be automatically conveyed
        _.remove(toParams, parameter => parameter.in === 'cookie');
        _.remove(fromParams, parameter => parameter.in === 'cookie');

        // We use a simple heuristic: We assume that parameters with the same name and same schema have identical meaning
        // across different operations. Therefore, we filter the potential links where all parameters for the to-operation
        // are already given by the from operation.
        const parameterMap = new Map<OpenAPIV3.ParameterObject, OpenAPIV3.ParameterObject>();
        const valid = toParams.every(toParam => {
          // If both schema-definitions are null the equality check also succeeds
          const fromParam = fromParams.find(p => areParametersMatching(openapi, toParam, p));
          if (fromParam != null) {
            //console.log("entrou aqui no nao nullo");
            parameterMap.set(fromParam, toParam);
            //let mapIter = parameterMap.keys();
            //console.log(mapIter.next().value);
            //let mapIter1 = parameterMap.values();
            //console.log(mapIter1.next().value);
            return true;
          } else {
            // We have not found a matching from-parameter. However, we do not need one if the parameter is optional.
            //console.log("entrou aqui no nullo ou falso");
            return toParam.required == null || toParam.required === false;
          }
        });
        //console.log("valor de valid: " + valid);

        if (valid) {
          newLinks.push({
            ...link,
            parameterMap
          });
          log.debug(`  Valid link candidate found: '${link.from}' => '${link.to}', ${parameterMap.size} parameter(s)`);
        }
      }


    }
    else if (toPath.hasOwnProperty('get') && !toPath.hasOwnProperty('post')) {
      console.log("GET");
      const toGet = toPath.get as OpenAPIV3.OperationObject;

      if (
        [...(toGet.parameters || []), ...(toPath.parameters || [])].some(
          parameter => '$ref' in parameter && isExternalRef(parameter)
        )
      ) {

        log.debug(`  Dropping link candidate due to external parameter reference: '${link.from}' => '${link.to}'`);
      }
      else {
        // Create parameter lists incorporating the path and the operation parameters.
        // At this point, we know that there are no external references in the to-path. We filter out all
        // the external references from the from-path.
        const fromParams = dereferenceParameters(
          //dereferencing the get parameters
          openapi,
          (fromGet.parameters || []).filter(param => !('$ref' in param && isExternalRef(param)))
        );
        if (fromPath.parameters != null) {
          fromParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, fromPath.parameters).filter(param =>
              fromParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        const toParams = dereferenceParameters(openapi, toGet.parameters || []);
        //console.log(toParams);
        if (toPath.parameters != null) {
          toParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, toPath.parameters).filter(param =>
              toParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        // Ignore cookie parameters as they are assumed to be automatically conveyed
        _.remove(toParams, parameter => parameter.in === 'cookie');
        _.remove(fromParams, parameter => parameter.in === 'cookie');

        // We use a simple heuristic: We assume that parameters with the same name and same schema have identical meaning
        // across different operations. Therefore, we filter the potential links where all parameters for the to-operation
        // are already given by the from operation.
        const parameterMap = new Map<OpenAPIV3.ParameterObject, OpenAPIV3.ParameterObject>();
        const valid = toParams.every(toParam => {
          // If both schema-definitions are null the equality check also succeeds
          const fromParam = fromParams.find(p => areParametersMatching(openapi, toParam, p));
          if (fromParam != null) {
            parameterMap.set(fromParam, toParam);
            return true;
          } else {
            // We have not found a matching from-parameter. However, we do not need one if the parameter is optional.
            return toParam.required == null || toParam.required === false;
          }
        });
        //console.log("valor de valid: " + valid);

        if (valid) {
          newLinks.push({
            ...link,
            parameterMap
          });
          log.debug(`  Valid link candidate found: '${link.from}' => '${link.to}', ${parameterMap.size} parameter(s)`);
        }
      }
    }
    else if (toPath.hasOwnProperty('post') && !toPath.hasOwnProperty('get')) {
      console.log("POST");
      const toPost = toPath.post as OpenAPIV3.OperationObject;

      if (
        [...(toPost.parameters || []), ...(toPath.parameters || [])].some(
          parameter => '$ref' in parameter && isExternalRef(parameter)
        )
      ) {

        log.debug(`  Dropping link candidate due to external parameter reference: '${link.from}' => '${link.to}'`);
      }
      else {
        // Create parameter lists incorporating the path and the operation parameters.
        // At this point, we know that there are no external references in the to-path. We filter out all
        // the external references from the from-path.
        const fromParams = dereferenceParameters(
          //dereferencing the get parameters
          openapi,
          (fromGet.parameters || []).filter(param => !('$ref' in param && isExternalRef(param)))
        );
        if (fromPath.parameters != null) {
          fromParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, fromPath.parameters).filter(param =>
              fromParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        const toParams = dereferenceParameters(openapi, toPost.parameters || []);
        //console.log(toParams);
        if (toPath.parameters != null) {
          toParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, toPath.parameters).filter(param =>
              toParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        // Ignore cookie parameters as they are assumed to be automatically conveyed
        _.remove(toParams, parameter => parameter.in === 'cookie');
        _.remove(fromParams, parameter => parameter.in === 'cookie');

        // We use a simple heuristic: We assume that parameters with the same name and same schema have identical meaning
        // across different operations. Therefore, we filter the potential links where all parameters for the to-operation
        // are already given by the from operation.
        const parameterMap = new Map<OpenAPIV3.ParameterObject, OpenAPIV3.ParameterObject>();
        const valid = toParams.every(toParam => {
          // If both schema-definitions are null the equality check also succeeds
          const fromParam = fromParams.find(p => areParametersMatching(openapi, toParam, p));
          if (fromParam != null) {
            parameterMap.set(fromParam, toParam);
            return true;
          } else {
            // We have not found a matching from-parameter. However, we do not need one if the parameter is optional.
            return toParam.required == null || toParam.required === false;
          }
        });
        //console.log("valor de valid: " + valid);

        if (valid) {
          newLinks.push({
            ...link,
            parameterMap
          });
          log.debug(`  Valid link candidate found: '${link.from}' => '${link.to}', ${parameterMap.size} parameter(s)`);
        }
      }


    }
    else if (toPath.hasOwnProperty('delete') && !toPath.hasOwnProperty('get') && !toPath.hasOwnProperty('post')) {
      console.log("DELETE");
      const toDelete = toPath.delete as OpenAPIV3.OperationObject;

      if (
        [...(toDelete.parameters || []), ...(toPath.parameters || [])].some(
          parameter => '$ref' in parameter && isExternalRef(parameter)
        )
      ) {

        log.debug(`  Dropping link candidate due to external parameter reference: '${link.from}' => '${link.to}'`);
      }
      else {
        // Create parameter lists incorporating the path and the operation parameters.
        // At this point, we know that there are no external references in the to-path. We filter out all
        // the external references from the from-path.
        const fromParams = dereferenceParameters(
          //dereferencing the get parameters
          openapi,
          (fromGet.parameters || []).filter(param => !('$ref' in param && isExternalRef(param)))
        );
        if (fromPath.parameters != null) {
          fromParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, fromPath.parameters).filter(param =>
              fromParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        const toParams = dereferenceParameters(openapi, toDelete.parameters || []);
        //console.log(toParams);
        if (toPath.parameters != null) {
          toParams.push(
            // Filter overriden parameters
            ...dereferenceParameters(openapi, toPath.parameters).filter(param =>
              toParams.every(innerParam => innerParam.name !== param.name)
            )
          );
        }
        // Ignore cookie parameters as they are assumed to be automatically conveyed
        _.remove(toParams, parameter => parameter.in === 'cookie');
        _.remove(fromParams, parameter => parameter.in === 'cookie');

        // We use a simple heuristic: We assume that parameters with the same name and same schema have identical meaning
        // across different operations. Therefore, we filter the potential links where all parameters for the to-operation
        // are already given by the from operation.
        const parameterMap = new Map<OpenAPIV3.ParameterObject, OpenAPIV3.ParameterObject>();
        const valid = toParams.every(toParam => {
          // If both schema-definitions are null the equality check also succeeds
          const fromParam = fromParams.find(p => areParametersMatching(openapi, toParam, p));
          if (fromParam != null) {
            parameterMap.set(fromParam, toParam);
            return true;
          } else {
            // We have not found a matching from-parameter. However, we do not need one if the parameter is optional.
            return toParam.required == null || toParam.required === false;
          }
        });
        //console.log("valor de valid: " + valid);

        if (valid) {
          newLinks.push({
            ...link,
            parameterMap
          });
          log.debug(`  Valid link candidate found: '${link.from}' => '${link.to}', ${parameterMap.size} parameter(s)`);
        }
      }

    }
  }
  log.debug(`Found ${newLinks.length} valid link candidates`);
  //console.log(newLinks);
  return newLinks;
}

/**
 * Adds link definitions to the given OpenAPI document based on a heuristic.
 *
 * A link from a path p1 to a path p2 is added under the following conditions:
 * - p2 starts with p1
 * - p1 and p2 have a get-request definition with at least one successful response defined
 * - For every required parameter of p2, there is a parameter with the same name and schema of p1
 * @param openapi The OpenAPI document
 */
export function addLinkDefinitions(openapi: OpenAPIV3.Document): { openapi: OpenAPIV3.Document; numLinks: number } {
  let numAddedLinks = 0;
  openapi = _.cloneDeep(openapi);
  const potLinks = processLinkParameters(openapi, findPotentialLinkPairs(openapi));

  potLinks.forEach(potLink => {
    console.log(potLink);
    const fromGet = openapi.paths[potLink.from].get as OpenAPIV3.OperationObject;
    const fromResponses = fromGet.responses as OpenAPIV3.ResponsesObject;

    if (openapi.paths[potLink.to].hasOwnProperty('get') && openapi.paths[potLink.to].hasOwnProperty('post') && openapi.paths[potLink.to].hasOwnProperty('delete')) {
      console.log("POST, DELETE, GET");
      const toGet = openapi.paths[potLink.to].get as OpenAPIV3.OperationObject;
      const toPost = openapi.paths[potLink.to].post as OpenAPIV3.OperationObject;
      const toDelete = openapi.paths[potLink.to].delete as OpenAPIV3.OperationObject;

      // All response objects for successful response codes for a get request.
      // $refs are resolved and deduplicated with _.uniq.
      // We know that this array is non empty because we filtered those in 'findPotentialLinkPairs'.
      const successGetResponses = _.uniq(
        Object.keys(fromResponses)
          .map(key => parseInt(key, 10))
          .filter(code => !isNaN(code) && code >= 200 && code < 300)
          .map(code => {
            const obj = fromResponses[code];
            if ('$ref' in obj) {
              return resolveComponentRef(openapi, obj, 'responses');
            } else {
              return obj;
            }
          })
      );

      // Create the link definition object
      const parametersObject: { [parameter: string]: any } = {};
      potLink.parameterMap.forEach((toParam, fromParam) => {
        // fromParam.in can only be 'query', 'header', 'path', 'cookie' according to the definition.
        // We have ruled out 'cookie' in 'processLinkParameters', so this is a valid Runtime Expression.
        parametersObject[toParam.name] = `$request.${fromParam.in}.${fromParam.name}`;
      });

      // We use the operationId when possible and the reference else
      let operationId: string | undefined;
      let operationRef: string | undefined;


      if (toGet.operationId != null) {
        operationId = toGet.operationId;
      } else {
        operationRef = '#' + serializeJsonPointer(['paths', potLink.to, 'get']);
      }

      const linkDefinitionGET = {
        description: `Automatically generated link definition`,
        ...(operationId != null ? { operationId } : {}),
        ...(operationRef != null ? { operationRef } : {}),
        parameters: parametersObject
      };
      //console.log(linkDefinitionGET);

      if (toPost.operationId != null) {
        operationId = toPost.operationId;
      } else {
        operationId = '#' + serializeJsonPointer(['paths', potLink.to, 'post']);
      }
      const linkDefinitionPOST = {
        description: `Automatically generated link definition`,
        ...(operationId != null ? { operationId } : {}),
        ...(operationRef != null ? { operationRef } : {}),
        parameters: parametersObject
      };

      if (toDelete.operationId != null) {
        operationId = toDelete.operationId;
      } else {
        operationId = '#' + serializeJsonPointer(['paths', potLink.to, 'delete']);
      }
      const linkDefinitionDELETE = {
        description: `Automatically generated link definition`,
        ...(operationId != null ? { operationId } : {}),
        ...(operationRef != null ? { operationRef } : {}),
        parameters: parametersObject
      };

      //console.log(linkDefinitionPOST);

      // Link Name is the name of the link in the link-definition of a response.
      const toLinkParts = potLink.to.split('/');
      //console.log(toLinkParts);
      const linkNameGET = toLinkParts[1] + capitalizeFirstLetter(sanitizeComponentName(
        potLink.to.endsWith('/') ? toLinkParts[toLinkParts.length - 2] : toLinkParts[toLinkParts.length - 1]
      )) + "GET";
      const linkNamePOST = toLinkParts[1] + capitalizeFirstLetter(sanitizeComponentName(
        potLink.to.endsWith('/') ? toLinkParts[toLinkParts.length - 2] : toLinkParts[toLinkParts.length - 1]
      )) + "POST";
      const linkNameDELETE = toLinkParts[1] + capitalizeFirstLetter(sanitizeComponentName(
        potLink.to.endsWith('/') ? toLinkParts[toLinkParts.length - 2] : toLinkParts[toLinkParts.length - 1]
      )) + "DELETE";


      //console.log(linkNameGET);
      //console.log(linkNamePOST);

      if (successGetResponses.length === 1) {
        // We only have one response, so we define the link directly in that response.
        const response = successGetResponses[0];
        if (response.links == null) {
          response.links = {};
        }

        // Prevent overwriting existing links
        let dedupLinkNameGET = linkNameGET;

        while (dedupLinkNameGET in response.links) {

          dedupLinkNameGET += '1';
        }

        response.links[dedupLinkNameGET] = linkDefinitionGET;
        numAddedLinks++;


        // Prevent overwriting existing links
        let dedupLinkNamePOST = linkNamePOST;

        while (dedupLinkNamePOST in response.links) {
          dedupLinkNamePOST += '1';
        }

        response.links[dedupLinkNamePOST] = linkDefinitionPOST;
        numAddedLinks++;

        let dedupLinkNameDELETE = linkNameDELETE;

        while (dedupLinkNameDELETE in response.links) {
          dedupLinkNameDELETE += '1';
        }

        response.links[dedupLinkNameDELETE] = linkDefinitionDELETE;
        numAddedLinks++;


        //console.log(response.links);
      } else {

        // We have multiple responses where this link should be added, so we save the link in
        // the components section and reference it in every response to prevent defining it multiple times.
        if (openapi.components == null) {
          openapi.components = {};
        }
        if (openapi.components.links == null) {
          openapi.components.links = {};
        }

        // Reference name is the name of the link-definition in the components-section.
        let referenceNameGET = linkNameGET;
        let referenceNamePOST = linkNamePOST;
        let referenceNameDELETE = linkNameDELETE;
        // Prevent overwriting existing link-components with the same name

        while (referenceNameGET in openapi.components.links) {
          referenceNameGET += '1';
        }

        openapi.components.links[referenceNameGET] = linkDefinitionGET;

        while (referenceNamePOST in openapi.components.links) {
          referenceNamePOST += '1';
        }

        openapi.components.links[referenceNamePOST] = linkDefinitionPOST;

        while (referenceNameDELETE in openapi.components.links) {
          referenceNameDELETE += '1';
        }
        openapi.components.links[referenceNameDELETE] = linkDefinitionDELETE;

        successGetResponses.forEach(response => {
          if (response.links == null) {
            response.links = {};
          }
          // Prevent overwriting existing links
          let dedupLinkNameGET = linkNameGET;

          while (dedupLinkNameGET in response.links) {
            dedupLinkNameGET += '1';
          }

          response.links[dedupLinkNameGET] = {
            $ref: '#' + serializeJsonPointer(['components', 'links', referenceNameGET])
          };
          numAddedLinks++;

          let dedupLinkNamePOST = linkNamePOST;

          while (dedupLinkNamePOST in response.links) {
            dedupLinkNamePOST += '1';
          }

          response.links[dedupLinkNamePOST] = {
            $ref: '#' + serializeJsonPointer(['components', 'links', referenceNamePOST])
          };
          numAddedLinks++;
          //console.log(response.links);

          let dedupLinkNameDELETE = linkNameDELETE;

          while (dedupLinkNameDELETE in response.links) {
            dedupLinkNameDELETE += '1';
          }

          response.links[dedupLinkNameDELETE] = {
            $ref: '#' + serializeJsonPointer(['components', 'links', referenceNameDELETE])
          };
          numAddedLinks++;
        });
      }

    }
    else if (openapi.paths[potLink.to].hasOwnProperty('get') && openapi.paths[potLink.to].hasOwnProperty('post') && !openapi.paths[potLink.to].hasOwnProperty('delete')) {
      //console.log(openapi.paths[potLink.to]);
      const toGet = openapi.paths[potLink.to].get as OpenAPIV3.OperationObject;
      const toPost = openapi.paths[potLink.to].post as OpenAPIV3.OperationObject;

      // All response objects for successful response codes for a get request.
      // $refs are resolved and deduplicated with _.uniq.
      // We know that this array is non empty because we filtered those in 'findPotentialLinkPairs'.
      const successGetResponses = _.uniq(
        Object.keys(fromResponses)
          .map(key => parseInt(key, 10))
          .filter(code => !isNaN(code) && code >= 200 && code < 300)
          .map(code => {
            const obj = fromResponses[code];
            if ('$ref' in obj) {
              return resolveComponentRef(openapi, obj, 'responses');
            } else {
              return obj;
            }
          })
      );

      // Create the link definition object
      const parametersObject: { [parameter: string]: any } = {};
      potLink.parameterMap.forEach((toParam, fromParam) => {
        // fromParam.in can only be 'query', 'header', 'path', 'cookie' according to the definition.
        // We have ruled out 'cookie' in 'processLinkParameters', so this is a valid Runtime Expression.
        parametersObject[toParam.name] = `$request.${fromParam.in}.${fromParam.name}`;
      });

      // We use the operationId when possible and the reference else
      let operationId: string | undefined;
      let operationRef: string | undefined;


      if (toGet.operationId != null) {
        operationId = toGet.operationId;
      } else {
        operationRef = '#' + serializeJsonPointer(['paths', potLink.to, 'get']);
      }

      const linkDefinitionGET = {
        description: `Automatically generated link definition`,
        ...(operationId != null ? { operationId } : {}),
        ...(operationRef != null ? { operationRef } : {}),
        parameters: parametersObject
      };
      //console.log(linkDefinitionGET);

      if (toPost.operationId != null) {
        operationId = toPost.operationId;
      } else {
        operationId = '#' + serializeJsonPointer(['paths', potLink.to, 'post']);
      }
      const linkDefinitionPOST = {
        description: `Automatically generated link definition`,
        ...(operationId != null ? { operationId } : {}),
        ...(operationRef != null ? { operationRef } : {}),
        parameters: parametersObject
      };

      //console.log(linkDefinitionPOST);

      // Link Name is the name of the link in the link-definition of a response.
      const toLinkParts = potLink.to.split('/');
      //console.log(toLinkParts);
      const linkNameGET = toLinkParts[1] + capitalizeFirstLetter(sanitizeComponentName(
        potLink.to.endsWith('/') ? toLinkParts[toLinkParts.length - 2] : toLinkParts[toLinkParts.length - 1]
      )) + "GET";
      const linkNamePOST = toLinkParts[1] + capitalizeFirstLetter(sanitizeComponentName(
        potLink.to.endsWith('/') ? toLinkParts[toLinkParts.length - 2] : toLinkParts[toLinkParts.length - 1]
      )) + "POST";


      //console.log(linkNameGET);
      //console.log(linkNamePOST);

      if (successGetResponses.length === 1) {
        // We only have one response, so we define the link directly in that response.
        const response = successGetResponses[0];
        if (response.links == null) {
          response.links = {};
        }

        // Prevent overwriting existing links
        let dedupLinkNameGET = linkNameGET;

        while (dedupLinkNameGET in response.links) {

          dedupLinkNameGET += '1';
        }

        response.links[dedupLinkNameGET] = linkDefinitionGET;
        numAddedLinks++;


        // Prevent overwriting existing links
        let dedupLinkNamePOST = linkNamePOST;

        while (dedupLinkNamePOST in response.links) {
          dedupLinkNamePOST += '1';
        }

        response.links[dedupLinkNamePOST] = linkDefinitionPOST;
        numAddedLinks++;
        //console.log(response.links);
      } else {

        // We have multiple responses where this link should be added, so we save the link in
        // the components section and reference it in every response to prevent defining it multiple times.
        if (openapi.components == null) {
          openapi.components = {};
        }
        if (openapi.components.links == null) {
          openapi.components.links = {};
        }

        // Reference name is the name of the link-definition in the components-section.
        let referenceNameGET = linkNameGET;
        let referenceNamePOST = linkNamePOST;
        // Prevent overwriting existing link-components with the same name

        while (referenceNameGET in openapi.components.links) {
          referenceNameGET += '1';
        }

        openapi.components.links[referenceNameGET] = linkDefinitionGET;

        while (referenceNamePOST in openapi.components.links) {
          referenceNamePOST += '1';
        }

        openapi.components.links[referenceNamePOST] = linkDefinitionPOST;

        successGetResponses.forEach(response => {
          if (response.links == null) {
            response.links = {};
          }
          // Prevent overwriting existing links
          let dedupLinkNameGET = linkNameGET;

          while (dedupLinkNameGET in response.links) {
            dedupLinkNameGET += '1';
          }

          response.links[dedupLinkNameGET] = {
            $ref: '#' + serializeJsonPointer(['components', 'links', referenceNameGET])
          };
          numAddedLinks++;

          let dedupLinkNamePOST = linkNamePOST;

          while (dedupLinkNamePOST in response.links) {
            dedupLinkNamePOST += '1';
          }

          response.links[dedupLinkNamePOST] = {
            $ref: '#' + serializeJsonPointer(['components', 'links', referenceNamePOST])
          };
          numAddedLinks++;
          //console.log(response.links);

        });
      }




    }
    else if (openapi.paths[potLink.to].hasOwnProperty('get') && !openapi.paths[potLink.to].hasOwnProperty('post')) {
      const toGet = openapi.paths[potLink.to].get as OpenAPIV3.OperationObject;

      // All response objects for successful response codes for a get request.
      // $refs are resolved and deduplicated with _.uniq.
      // We know that this array is non empty because we filtered those in 'findPotentialLinkPairs'.
      const successGetResponses = _.uniq(
        Object.keys(fromResponses)
          .map(key => parseInt(key, 10))
          .filter(code => !isNaN(code) && code >= 200 && code < 300)
          .map(code => {
            const obj = fromResponses[code];
            if ('$ref' in obj) {
              return resolveComponentRef(openapi, obj, 'responses');
            } else {
              return obj;
            }
          })
      );

      // Create the link definition object
      const parametersObject: { [parameter: string]: any } = {};
      potLink.parameterMap.forEach((toParam, fromParam) => {
        // fromParam.in can only be 'query', 'header', 'path', 'cookie' according to the definition.
        // We have ruled out 'cookie' in 'processLinkParameters', so this is a valid Runtime Expression.
        parametersObject[toParam.name] = `$request.${fromParam.in}.${fromParam.name}`;
      });

      // We use the operationId when possible and the reference else
      let operationId: string | undefined;
      let operationRef: string | undefined;


      if (toGet.operationId != null) {
        operationId = toGet.operationId;
      } else {
        operationRef = '#' + serializeJsonPointer(['paths', potLink.to, 'get']);
      }

      const linkDefinitionGET = {
        description: `Automatically generated link definition`,
        ...(operationId != null ? { operationId } : {}),
        ...(operationRef != null ? { operationRef } : {}),
        parameters: parametersObject
      };

      // Link Name is the name of the link in the link-definition of a response.
      const toLinkParts = potLink.to.split('/');
      //console.log(toLinkParts);
      const linkNameGET = toLinkParts[1] + capitalizeFirstLetter(sanitizeComponentName(
        potLink.to.endsWith('/') ? toLinkParts[toLinkParts.length - 2] : toLinkParts[toLinkParts.length - 1]
      ));
      //console.log(linkNameGET);

      if (successGetResponses.length === 1) {
        // We only have one response, so we define the link directly in that response.
        const response = successGetResponses[0];
        if (response.links == null) {
          response.links = {};
        }

        // Prevent overwriting existing links
        let dedupLinkNameGET = linkNameGET;

        while (dedupLinkNameGET in response.links) {
          dedupLinkNameGET += '1';
        }

        response.links[dedupLinkNameGET] = linkDefinitionGET;
        numAddedLinks++;
      } else {

        // We have multiple responses where this link should be added, so we save the link in
        // the components section and reference it in every response to prevent defining it multiple times.
        if (openapi.components == null) {
          openapi.components = {};
        }
        if (openapi.components.links == null) {
          openapi.components.links = {};
        }

        // Reference name is the name of the link-definition in the components-section.
        let referenceNameGET = linkNameGET;
        // Prevent overwriting existing link-components with the same name

        while (referenceNameGET in openapi.components.links) {
          referenceNameGET += '1';
        }

        openapi.components.links[referenceNameGET] = linkDefinitionGET;

        successGetResponses.forEach(response => {
          if (response.links == null) {
            response.links = {};
          }
          // Prevent overwriting existing links
          let dedupLinkNameGET = linkNameGET;

          while (dedupLinkNameGET in response.links) {
            dedupLinkNameGET += '1';
          }

          response.links[dedupLinkNameGET] = {
            $ref: '#' + serializeJsonPointer(['components', 'links', referenceNameGET])
          };
          numAddedLinks++;

          //console.log(response.links);

        });
      }
    }

    else if (openapi.paths[potLink.to].hasOwnProperty('post') && !openapi.paths[potLink.to].hasOwnProperty('get')) {
      const toPost = openapi.paths[potLink.to].post as OpenAPIV3.OperationObject;

      // All response objects for successful response codes for a get request.
      // $refs are resolved and deduplicated with _.uniq.
      // We know that this array is non empty because we filtered those in 'findPotentialLinkPairs'.
      const successGetResponses = _.uniq(
        Object.keys(fromResponses)
          .map(key => parseInt(key, 10))
          .filter(code => !isNaN(code) && code >= 200 && code < 300)
          .map(code => {
            const obj = fromResponses[code];
            if ('$ref' in obj) {
              return resolveComponentRef(openapi, obj, 'responses');
            } else {
              return obj;
            }
          })
      );

      // Create the link definition object
      const parametersObject: { [parameter: string]: any } = {};
      potLink.parameterMap.forEach((toParam, fromParam) => {
        // fromParam.in can only be 'query', 'header', 'path', 'cookie' according to the definition.
        // We have ruled out 'cookie' in 'processLinkParameters', so this is a valid Runtime Expression.
        parametersObject[toParam.name] = `$request.${fromParam.in}.${fromParam.name}`;
      });

      // We use the operationId when possible and the reference else
      let operationId: string | undefined;
      let operationRef: string | undefined;


      if (toPost.operationId != null) {
        operationId = toPost.operationId;
      } else {
        operationRef = '#' + serializeJsonPointer(['paths', potLink.to, 'post']);
      }

      const linkDefinitionPOST = {
        description: `Automatically generated link definition`,
        ...(operationId != null ? { operationId } : {}),
        ...(operationRef != null ? { operationRef } : {}),
        parameters: parametersObject
      };

      // Link Name is the name of the link in the link-definition of a response.
      const toLinkParts = potLink.to.split('/');
      //console.log(toLinkParts);
      const linkNamePOST = toLinkParts[1] + capitalizeFirstLetter(sanitizeComponentName(
        potLink.to.endsWith('/') ? toLinkParts[toLinkParts.length - 2] : toLinkParts[toLinkParts.length - 1]
      ));

      if (successGetResponses.length === 1) {
        // We only have one response, so we define the link directly in that response.
        const response = successGetResponses[0];
        if (response.links == null) {
          response.links = {};
        }

        // Prevent overwriting existing links
        let dedupLinkNamePOST = linkNamePOST;

        while (dedupLinkNamePOST in response.links) {

          dedupLinkNamePOST += '1';
        }

        response.links[dedupLinkNamePOST] = linkDefinitionPOST;
        numAddedLinks++;
      } else {

        // We have multiple responses where this link should be added, so we save the link in
        // the components section and reference it in every response to prevent defining it multiple times.
        if (openapi.components == null) {
          openapi.components = {};
        }
        if (openapi.components.links == null) {
          openapi.components.links = {};
        }

        // Reference name is the name of the link-definition in the components-section.
        let referenceNamePOST = linkNamePOST;
        // Prevent overwriting existing link-components with the same name

        while (referenceNamePOST in openapi.components.links) {
          referenceNamePOST += '1';
        }

        openapi.components.links[referenceNamePOST] = linkDefinitionPOST;

        successGetResponses.forEach(response => {
          if (response.links == null) {
            response.links = {};
          }
          // Prevent overwriting existing links
          let dedupLinkNamePOST = linkNamePOST;

          while (dedupLinkNamePOST in response.links) {
            dedupLinkNamePOST += '1';
          }

          response.links[dedupLinkNamePOST] = {
            $ref: '#' + serializeJsonPointer(['components', 'links', referenceNamePOST])
          };
          numAddedLinks++;

          //console.log(response.links);

        });
      }
    }
    else if (openapi.paths[potLink.to].hasOwnProperty('delete') && !openapi.paths[potLink.to].hasOwnProperty('get') && !openapi.paths[potLink.to].hasOwnProperty('post')) {
      const toDelete = openapi.paths[potLink.to].delete as OpenAPIV3.OperationObject;

      // All response objects for successful response codes for a get request.
      // $refs are resolved and deduplicated with _.uniq.
      // We know that this array is non empty because we filtered those in 'findPotentialLinkPairs'.
      const successGetResponses = _.uniq(
        Object.keys(fromResponses)
          .map(key => parseInt(key, 10))
          .filter(code => !isNaN(code) && code >= 200 && code < 300)
          .map(code => {
            const obj = fromResponses[code];
            if ('$ref' in obj) {
              return resolveComponentRef(openapi, obj, 'responses');
            } else {
              return obj;
            }
          })
      );

      // Create the link definition object
      const parametersObject: { [parameter: string]: any } = {};
      potLink.parameterMap.forEach((toParam, fromParam) => {
        // fromParam.in can only be 'query', 'header', 'path', 'cookie' according to the definition.
        // We have ruled out 'cookie' in 'processLinkParameters', so this is a valid Runtime Expression.
        parametersObject[toParam.name] = `$request.${fromParam.in}.${fromParam.name}`;
      });

      // We use the operationId when possible and the reference else
      let operationId: string | undefined;
      let operationRef: string | undefined;


      if (toDelete.operationId != null) {
        operationId = toDelete.operationId;
      } else {
        operationRef = '#' + serializeJsonPointer(['paths', potLink.to, 'delete']);
      }

      const linkDefinitionDELETE = {
        description: `Automatically generated link definition`,
        ...(operationId != null ? { operationId } : {}),
        ...(operationRef != null ? { operationRef } : {}),
        parameters: parametersObject
      };

      // Link Name is the name of the link in the link-definition of a response.
      const toLinkParts = potLink.to.split('/');
      //console.log(toLinkParts);
      const linkNameDelete = toLinkParts[1] + capitalizeFirstLetter(sanitizeComponentName(
        potLink.to.endsWith('/') ? toLinkParts[toLinkParts.length - 2] : toLinkParts[toLinkParts.length - 1]
      ));

      if (successGetResponses.length === 1) {
        // We only have one response, so we define the link directly in that response.
        const response = successGetResponses[0];
        if (response.links == null) {
          response.links = {};
        }

        // Prevent overwriting existing links
        let dedupLinkNameDELETE = linkNameDelete;

        while (dedupLinkNameDELETE in response.links) {

          dedupLinkNameDELETE += '1';
        }

        response.links[dedupLinkNameDELETE] = linkDefinitionDELETE;
        numAddedLinks++;
      } else {

        // We have multiple responses where this link should be added, so we save the link in
        // the components section and reference it in every response to prevent defining it multiple times.
        if (openapi.components == null) {
          openapi.components = {};
        }
        if (openapi.components.links == null) {
          openapi.components.links = {};
        }

        // Reference name is the name of the link-definition in the components-section.
        let referenceNameDELETE = linkNameDelete;
        // Prevent overwriting existing link-components with the same name

        while (referenceNameDELETE in openapi.components.links) {
          referenceNameDELETE += '1';
        }

        openapi.components.links[referenceNameDELETE] = linkDefinitionDELETE;

        successGetResponses.forEach(response => {
          if (response.links == null) {
            response.links = {};
          }
          // Prevent overwriting existing links
          let dedupLinkNamePOST = linkNameDelete;

          while (dedupLinkNamePOST in response.links) {
            dedupLinkNamePOST += '1';
          }

          response.links[dedupLinkNamePOST] = {
            $ref: '#' + serializeJsonPointer(['components', 'links', referenceNameDELETE])
          };
          numAddedLinks++;

          //console.log(response.links);

        });
      }
    }






  });

  log.info(`Added ${numAddedLinks} links to response definitions`);
  return { openapi, numLinks: numAddedLinks };
}

