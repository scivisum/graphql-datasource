import defaults from 'lodash/defaults';

import {
  AnnotationEvent,
  AnnotationQueryRequest,
  DataFrame,
  DataQueryRequest,
  DataQueryResponse,
  DataSourceApi,
  DataSourceInstanceSettings,
  dateTime,
  FieldType,
  MetricFindValue,
  MutableDataFrame,
  ScopedVars,
  TimeRange,
} from '@grafana/data';

import {
  defaultQuery,
  MultiValueVariable,
  MyDataSourceOptions,
  MyQuery,
  MyVariableQuery,
  RequestFactory,
  TextValuePair,
} from './types';
import { getTemplateSrv } from '@grafana/runtime';
import { isEqual } from 'lodash';
import { flatten, isRFC3339_ISO6801 } from './util';
import { getOperationAST, GraphQLObjectType, isObjectType, parse } from 'graphql';
import { Schema } from './schema';
import assert from 'assert';
import { getAliasIfExists, getDescendantNode, hasSelectionSet } from './query';

const supportedVariableTypes = ['constant', 'custom', 'query', 'textbox'];

class _RequestFactory implements RequestFactory {
  constructor(
    private basicAuth: string | undefined,
    private withCredentials: boolean | undefined,
    private url: string,
    private backendSrv: any
  ) {
    this.basicAuth = basicAuth;
    this.withCredentials = withCredentials;
    this.url = url;
    this.backendSrv = backendSrv;
  }

  request(data: string): Promise<any> {
    const options: any = {
      url: this.url,
      method: 'POST',
      data: {
        query: data,
      },
    };

    if (this.basicAuth || this.withCredentials) {
      options.withCredentials = true;
    }
    if (this.basicAuth) {
      options.headers = {
        Authorization: this.basicAuth,
      };
    }

    return this.backendSrv.datasourceRequest(options);
  }
}

export class DataSource extends DataSourceApi<MyQuery, MyDataSourceOptions> {
  private schema: Schema;
  private requestFactory: RequestFactory;

  constructor(instanceSettings: DataSourceInstanceSettings<MyDataSourceOptions>, backendSrv: any) {
    super(instanceSettings);
    this.requestFactory = new _RequestFactory(
      instanceSettings.basicAuth,
      instanceSettings.withCredentials,
      instanceSettings.url as string,
      backendSrv
    );
    this.schema = new Schema(this.requestFactory);
  }

  private postQuery(query: Partial<MyQuery>, payload: string) {
    return this.requestFactory
      .request(payload)
      .then((results: any) => {
        return { query, results };
      })
      .catch((err: any) => {
        if (err.data && err.data.error) {
          throw {
            message: 'GraphQL error: ' + err.data.error.reason,
            error: err.data.error,
          };
        }

        throw err;
      });
  }

  private createQuery(query: MyQuery, range: TimeRange | undefined, scopedVars: ScopedVars | undefined = undefined) {
    let payload = getTemplateSrv().replace(query.queryText, {
      ...scopedVars,
      timeFrom: { text: 'from', value: range?.from.valueOf() },
      timeTo: { text: 'to', value: range?.to.valueOf() },
    });

    //console.log(payload);
    return this.postQuery(query, payload);
  }
  private static getDocs(resultsData: any, dataPath: string): any[] {
    if (!resultsData) {
      throw 'resultsData was null or undefined';
    }

    let data = dataPath.split('.').reduce((d: any, p: any) => {
      if (!d) {
        return null;
      }
      if (Array.isArray(d)) {
        // Look up `p` in each item in the list. If we find an array, copy the fields of the
        // item to each doc in the array, so we can group on them.
        let docs = [];
        for (const item of d) {
          if (Array.isArray(item[p])) {
            for (const doc of item[p]) {
              for (const field in item) {
                if (field !== p) {
                  doc['..' + field] = item[field];
                }
              }
              docs.push(doc);
            }
          } else {
            docs.push(item[p]);
          }
        }
        return docs;
      } else {
        return d[p];
      }
    }, resultsData.data);
    if (!data) {
      const errors: any[] = resultsData.errors;
      if (errors && errors.length !== 0) {
        throw errors[0];
      }
      throw 'Your data path did not exist! dataPath: ' + dataPath;
    }
    if (resultsData.errors) {
      // There can still be errors even if there is data
      console.log('Got GraphQL errors:');
      console.log(resultsData.errors);
    }
    const docs: any[] = [];
    let pushDoc = (originalDoc: object) => {
      docs.push(flatten(originalDoc));
    };
    if (Array.isArray(data)) {
      for (const element of data) {
        pushDoc(element);
      }
    } else {
      pushDoc(data);
    }
    return docs;
  }
  private static getDataPathArray(dataPathString: string): string[] {
    const dataPathArray: string[] = [];
    for (const dataPath of dataPathString.split(',')) {
      const trimmed = dataPath.trim();
      if (trimmed) {
        dataPathArray.push(trimmed);
      }
    }
    if (!dataPathArray) {
      throw 'data path is empty!';
    }
    return dataPathArray;
  }

  async query(options: DataQueryRequest<MyQuery>): Promise<DataQueryResponse> {
    let promises: Array<Promise<any>> = options.targets.map((target) => {
      return this.createQuery(defaults(target, defaultQuery), options.range, options.scopedVars);
    });
    promises.push(this.schema.getQuery());

    return Promise.all(promises).then((results) => {
      const dataFrameArray: DataFrame[] = [];
      let queryType: GraphQLObjectType = results.pop();

      // Parse the query so we can find aliases. We can assert various things about the query
      // structure because it was used to generate the results we're processing.
      // We must remove variables like `${pmeOn}` because the syntax clashes with GraphQL.
      // @ts-ignore (it thinks `replaceAll` doesn't exist)
      const mungedQuery = options.targets[0].queryText.replaceAll(/\${[^}]+}/g, 'PLUGIN_VARIABLE');
      const queryDocument = getOperationAST(parse(mungedQuery));
      assert(queryDocument);

      for (let res of results) {
        const dataPathArray: string[] = DataSource.getDataPathArray(res.query.dataPath);
        const { timePath, timeFormat, groupBy, aliasBy } = res.query;
        const split = groupBy.split(',');
        const groupByList: string[] = [];
        for (const element of split) {
          const trimmed = element.trim();
          if (trimmed) {
            groupByList.push(trimmed);
          }
        }
        for (const dataPath of dataPathArray) {
          const docs: any[] = DataSource.getDocs(res.results.data, dataPath);
          let dataType = Schema.getTypeOfDescendant(queryType, dataPath);
          if (!isObjectType(dataType)) {
            throw `Data path ${dataPath} has type ${dataType.name}, expected object type`;
          }
          const dataPathQueryNode = getDescendantNode(queryDocument, dataPath);
          if (!hasSelectionSet(dataPathQueryNode)) {
            throw `Query selects no fields from data path`;
          }

          const dataFrameMap = new Map<string, MutableDataFrame>();
          for (const doc of docs) {
            if (timePath in doc) {
              doc[timePath] = dateTime(doc[timePath], timeFormat);
            }
            const identifiers: string[] = [];
            for (const groupByElement of groupByList) {
              identifiers.push(doc[groupByElement]);
            }
            const identifiersString = identifiers.toString();
            let dataFrame = dataFrameMap.get(identifiersString);
            if (!dataFrame) {
              // we haven't initialized the dataFrame for this specific identifier that we group by yet
              dataFrame = new MutableDataFrame({ fields: [] });
              const generalReplaceObject: any = {};
              for (const fieldName in doc) {
                generalReplaceObject['field_' + fieldName] = doc[fieldName];
              }
              for (let fieldName in doc) {
                let t: FieldType = FieldType.string;
                if (fieldName === timePath || isRFC3339_ISO6801(String(doc[fieldName]))) {
                  t = FieldType.time;
                } else if (!fieldName.startsWith('..')) {
                  // Don't bother looking up the schema for the type of parent fields, because
                  // we're not going to plot them. Leave them as strings.

                  // If the field was aliased, find the underlying field, because that defines the
                  // type.
                  const aliasNode = getAliasIfExists(dataPathQueryNode, fieldName);
                  const unaliasedFieldName = aliasNode ? aliasNode.name.value : fieldName;

                  let fieldType = Schema.getTypeOfDescendant(dataType, unaliasedFieldName);
                  if (Schema.isNumericType(fieldType)) {
                    t = FieldType.number;
                  }
                }

                let title;
                if (identifiers.length !== 0) {
                  // if we have any identifiers
                  title = identifiersString + '_' + fieldName;
                } else {
                  title = fieldName;
                }
                if (aliasBy) {
                  title = aliasBy;
                  const replaceObject = { ...generalReplaceObject };
                  replaceObject['fieldName'] = fieldName;
                  for (const replaceKey in replaceObject) {
                    const replaceValue = replaceObject[replaceKey];
                    const regex = new RegExp('\\$' + replaceKey, 'g');
                    title = title.replace(regex, replaceValue);
                  }
                  title = getTemplateSrv().replace(title, options.scopedVars);
                }
                dataFrame.addField({
                  name: fieldName,
                  type: t,
                  config: { displayName: title },
                }).parse = (v: any) => {
                  return v || '';
                };
              }
              dataFrameMap.set(identifiersString, dataFrame);
            }

            dataFrame.add(doc);
          }
          for (const dataFrame of dataFrameMap.values()) {
            dataFrameArray.push(dataFrame);
          }
        }
      }
      return { data: dataFrameArray };
    });
  }
  annotationQuery(options: AnnotationQueryRequest<MyQuery>): Promise<AnnotationEvent[]> {
    const query = defaults(options.annotation, defaultQuery);
    return Promise.all([this.createQuery(query, options.range)]).then((results: any) => {
      const r: AnnotationEvent[] = [];
      for (const res of results) {
        const { timePath, endTimePath, timeFormat } = res.query;
        const dataPathArray: string[] = DataSource.getDataPathArray(res.query.dataPath);
        for (const dataPath of dataPathArray) {
          const docs: any[] = DataSource.getDocs(res.results.data, dataPath);
          for (const doc of docs) {
            const annotation: AnnotationEvent = {};
            if (timePath in doc) {
              annotation.time = dateTime(doc[timePath], timeFormat).valueOf();
            }
            if (endTimePath in doc) {
              annotation.isRegion = true;
              annotation.timeEnd = dateTime(doc[endTimePath], timeFormat).valueOf();
            }
            let title = query.annotationTitle;
            let text = query.annotationText;
            let tags = query.annotationTags;
            for (const fieldName in doc) {
              const fieldValue = doc[fieldName];
              const replaceKey = 'field_' + fieldName;
              const regex = new RegExp('\\$' + replaceKey, 'g');
              title = title.replace(regex, fieldValue);
              text = text.replace(regex, fieldValue);
              tags = tags.replace(regex, fieldValue);
            }

            annotation.title = title;
            annotation.text = text;
            const tagsList: string[] = [];
            for (const element of tags.split(',')) {
              const trimmed = element.trim();
              if (trimmed) {
                tagsList.push(trimmed);
              }
            }
            annotation.tags = tagsList;
            r.push(annotation);
          }
        }
      }
      return r;
    });
  }

  testDatasource() {
    const q = `{
      __schema{
        queryType{name}
      }
    }`;
    return this.postQuery(defaultQuery, q).then(
      (res: any) => {
        if (res.errors) {
          console.log(res.errors);
          return {
            status: 'error',
            message: 'GraphQL Error: ' + res.errors[0].message,
          };
        }
        return {
          status: 'success',
          message: 'Success',
        };
      },
      (err: any) => {
        console.log(err);
        return {
          status: 'error',
          message: 'HTTP Response ' + err.status + ': ' + err.statusText,
        };
      }
    );
  }

  async metricFindQuery(query: MyVariableQuery, options?: any) {
    const metricFindValues: MetricFindValue[] = [];

    query = defaults(query, defaultQuery);

    let payload = query.queryText;
    payload = getTemplateSrv().replace(payload, { ...this.getVariables });

    const response = await this.postQuery(query, payload);

    const docs: any[] = DataSource.getDocs(response.results.data, query.dataPath);

    for (const doc of docs) {
      if ('__text' in doc && '__value' in doc) {
        metricFindValues.push({ text: doc['__text'], value: doc['__value'] });
      } else {
        for (const fieldName in doc) {
          metricFindValues.push({ text: doc[fieldName] });
        }
      }
    }

    return metricFindValues;
  }

  getVariables() {
    const variables: { [id: string]: TextValuePair } = {};
    Object.values(getTemplateSrv().getVariables()).forEach((variable) => {
      if (!supportedVariableTypes.includes(variable.type)) {
        console.warn(`Variable of type "${variable.type}" is not supported`);

        return;
      }

      const supportedVariable = variable as MultiValueVariable;

      let variableValue = supportedVariable.current.value;
      if (variableValue === '$__all' || isEqual(variableValue, ['$__all'])) {
        if (supportedVariable.allValue === null || supportedVariable.allValue === '') {
          variableValue = supportedVariable.options.slice(1).map((textValuePair) => textValuePair.value);
        } else {
          variableValue = supportedVariable.allValue;
        }
      }

      variables[supportedVariable.id] = {
        text: supportedVariable.current.text,
        value: variableValue,
      };
    });

    return variables;
  }
}
