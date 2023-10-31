import { getOperationAST, parse } from 'graphql';
import { getAliasIfExists, getDescendantNode } from './query';

test('getDescendantNode', () => {
  const queryNode = getOperationAST(
    parse(`
        query {
            foo {
                bar {
                    baz
                }
            }
        }
    `)
  );

  const foo = getDescendantNode(queryNode!, 'foo');
  expect(foo).toBeDefined();
  expect(foo.name.value).toBe('foo');

  const baz = getDescendantNode(queryNode!, 'foo.bar.baz');
  expect(baz).toBeDefined();
  expect(baz.name.value).toBe('baz');
});

test('getAliasIfExists', () => {
  const queryNode = getOperationAST(
    parse(`
        query {
            foo {
                bar: baz
                boz
            }
        }
    `)
  );
  const foo = getDescendantNode(queryNode!, 'foo');

  const alias = getAliasIfExists(foo, 'bar');
  expect(alias).toBeDefined();
  expect(alias?.name.value).toBe('baz');
  expect(getAliasIfExists(foo, 'boz')).not.toBeDefined();
});
