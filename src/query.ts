import { SelectionSetNode } from 'graphql/language/ast';
import { FieldNode, OperationDefinitionNode } from 'graphql';

function getNodeByName(node: { selectionSet: SelectionSetNode }, name: string): FieldNode {
  const fieldNode = node.selectionSet.selections.find(
    (s): s is FieldNode => s.kind === 'Field' && s.name.value === name
  );
  if (!fieldNode) {
    throw `Field ${name} not found in ${node}`;
  }
  return fieldNode;
}

type HasSelectionSet = {
  selectionSet: SelectionSetNode;
};

export function hasSelectionSet(node: { selectionSet?: SelectionSetNode }): node is HasSelectionSet {
  return !!node.selectionSet;
}

export function getDescendantNode(queryNode: OperationDefinitionNode, path: string): FieldNode {
  const pathComponents = path.split('.');
  let node: HasSelectionSet = queryNode;
  let fieldNode: FieldNode;
  for (let i = 0; i < pathComponents.length; i++) {
    fieldNode = getNodeByName(node, pathComponents[i]);
    if (i === pathComponents.length - 1) {
      return fieldNode;
    } else {
      if (!hasSelectionSet(fieldNode)) {
        throw `Node ${fieldNode} at path component ${i} of ${path} has no fields`;
      }
      node = fieldNode;
    }
  }
  throw `Invalid path: ${path}`;
}

export function getAliasIfExists(node: { selectionSet?: SelectionSetNode }, name: string): FieldNode | undefined {
  if (node.selectionSet) {
    return node.selectionSet.selections.find((s): s is FieldNode => s.kind === 'Field' && s.alias?.value === name);
  } else {
    return undefined;
  }
}
