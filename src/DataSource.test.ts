import { DataSource } from './DataSource';

describe('getDocs', () => {
  it('simple', () => {
    // @ts-ignore
    const docs = DataSource.getDocs(
      {
        data: {
          a1: {
            b1: [{ c: 1 }, { c: 2 }],
            b2: [{ c: 3 }, { c: 4 }],
          },
          a2: {
            b1: [],
          },
        },
      },
      'a1.b1'
    );

    expect(docs).toStrictEqual([{ c: 1 }, { c: 2 }]);
  });

  it('simple array', () => {
    // @ts-ignore
    const docs = DataSource.getDocs(
      {
        data: {
          a1: [
            {
              b1: [{ c: 1 }, { c: 2 }],
              b2: 'foo',
            },
            {
              b1: [{ c: 3 }, { c: 4 }],
              b2: 'bar',
            },
          ],
        },
      },
      'a1.b1'
    );

    expect(docs).toStrictEqual([
      { c: 1, '..b2': 'foo' },
      { c: 2, '..b2': 'foo' },
      { c: 3, '..b2': 'bar' },
      { c: 4, '..b2': 'bar' },
    ]);
  });
});
