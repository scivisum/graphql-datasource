import {
  buildClientSchema,
  getIntrospectionQuery,
  getNamedType,
  GraphQLNamedType,
  GraphQLObjectType,
  isObjectType,
  isScalarType,
  printSchema,
} from 'graphql';
import { RequestFactory } from './types';

export class Schema {
  private query: Promise<GraphQLObjectType> | undefined;

  constructor(private requestFactory: RequestFactory) {
    this.requestFactory = requestFactory;
  }

  getQuery(): Promise<GraphQLObjectType> {
    if (!this.query) {
      this.query = this.requestFactory.request(getIntrospectionQuery()).then((results: any) => {
        let schema = buildClientSchema(results.data.data);
        let queryType = schema.getQueryType();
        if (!queryType) {
          throw `No query type in schema: ${printSchema(schema)}`;
        }
        return queryType;
      });
    }
    // @ts-ignore (it's defined now)
    return this.query;
  }

  static getTypeOfDescendant(nodeType: GraphQLObjectType, path: string): GraphQLNamedType {
    let descendantType = nodeType;
    let pathComponents = path.split('.');
    for (let i = 0; i < pathComponents.length; i++) {
      if (!isNaN(Number(pathComponents[i]))) {
        // Skip over path components which are really list indices. The next path component is a
        // field of the current node.
        continue;
      }

      let type = getNamedType(descendantType.getFields()[pathComponents[i]].type);
      if (i === pathComponents.length - 1) {
        return type;
      } else if (type.name === 'GenericScalar') {
        // We've hit an untyped field. Any subfield of such a field must also be untyped, so we
        // can just return now.
        return type;
      } else {
        if (!isObjectType(type)) {
          throw `Found type ${type.name} for component ${pathComponents[i]} of ${path}, expected object type`;
        }
        descendantType = type as GraphQLObjectType;
      }
    }
    return descendantType;
  }

  static isNumericType(fieldType: GraphQLNamedType): boolean {
    return isScalarType(fieldType) && (fieldType.name === 'Int' || fieldType.name === 'Float');
  }
}
