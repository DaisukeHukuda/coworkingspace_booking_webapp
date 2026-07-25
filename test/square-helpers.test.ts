import { describe, it, expect } from 'vitest';
import { fetchLocations, fetchBookableServices } from '../src/core/square';

const ENV = { SQUARE_ACCESS_TOKEN: 'tok' };

// 固定のJSONを返すモック fetcher。呼び出し記録も返す。
function jsonFetcher(payload: unknown, status = 200) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('square list helpers', () => {
  it('fetchLocations は locations のIDと名前を返す（URL・ヘッダも正しい）', async () => {
    const { fetcher, calls } = jsonFetcher({
      locations: [
        { id: 'L1', name: 'TORCH日光' },
        { id: 'L2' } // name欠落はIDで代用
      ]
    });
    const result = await fetchLocations(ENV, fetcher);
    expect(result).toEqual({ ok: true, items: [{ id: 'L1', name: 'TORCH日光' }, { id: 'L2', name: 'L2' }] });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe('https://connect.squareup.com/v2/locations');
    const headers = calls[0].init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers['square-version']).toBe('2024-08-21');
  });

  it('fetchLocations はトークン未設定なら fetcher を呼ばず、HTTP失敗・例外も ok:false', async () => {
    let called = false;
    const spy = (async () => { called = true; return new Response('{}'); }) as typeof fetch;
    expect(await fetchLocations({}, spy)).toEqual({ ok: false, error: 'no_token' });
    expect(called).toBe(false);

    const fail = (async () => new Response('denied', { status: 401 })) as typeof fetch;
    expect(await fetchLocations(ENV, fail)).toEqual({ ok: false, error: 'HTTP 401' });

    const boom = (async () => { throw new Error('network down'); }) as typeof fetch;
    expect(await fetchLocations(ENV, boom)).toEqual({ ok: false, error: 'network down' });
  });

  it('fetchLocations は想定外の形状でも不正要素だけ無視して継続する', async () => {
    const { fetcher } = jsonFetcher({ locations: [{ id: 'L1', name: 'OK' }, { name: 'idなし' }, 'ただの文字列', { id: 42 }] });
    expect(await fetchLocations(ENV, fetcher)).toEqual({ ok: true, items: [{ id: 'L1', name: 'OK' }] });

    const { fetcher: noList } = jsonFetcher({ nonsense: true });
    expect(await fetchLocations(ENV, noList)).toEqual({ ok: true, items: [] }); // locations欠落は空一覧
  });

  it('fetchBookableServices は予約サービスのバリエーションを平坦化して返す', async () => {
    const { fetcher, calls } = jsonFetcher({
      items: [
        {
          item_data: {
            name: 'コワーキング利用',
            variations: [
              { id: 'V1', item_variation_data: { name: 'ドロップイン' } },
              { id: 'V2', item_variation_data: { name: '半日' } }
            ]
          }
        },
        { item_data: { name: '単一サービス', variations: [{ id: 'V3', item_variation_data: { name: '単一サービス' } }] } }
      ]
    });
    const result = await fetchBookableServices(ENV, fetcher);
    expect(result).toEqual({
      ok: true,
      items: [
        { id: 'V1', name: 'コワーキング利用（ドロップイン）' },
        { id: 'V2', name: 'コワーキング利用（半日）' },
        { id: 'V3', name: '単一サービス' } // アイテム名とバリエーション名が同じなら括弧は付けない
      ]
    });
    expect(calls[0].url).toBe('https://connect.squareup.com/v2/catalog/search-catalog-items');
    expect(calls[0].init!.method).toBe('POST');
    const body = JSON.parse(String(calls[0].init!.body));
    expect(body.product_types).toEqual(['APPOINTMENTS_SERVICE']);
  });

  it('fetchBookableServices は失敗・不正形状でも例外を投げない', async () => {
    expect(await fetchBookableServices({}, (async () => new Response('{}')) as typeof fetch)).toEqual({ ok: false, error: 'no_token' });

    const fail = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    expect(await fetchBookableServices(ENV, fail)).toEqual({ ok: false, error: 'HTTP 500' });

    const { fetcher } = jsonFetcher({
      items: [
        { item_data: { name: 'X', variations: [{ item_variation_data: {} }, { id: 'V9', item_variation_data: { name: 7 } }] } },
        { no_item_data: true }
      ]
    });
    // id の無いバリエーション・name不正・item_data欠落は無視し、拾えるものだけ返す
    expect(await fetchBookableServices(ENV, fetcher)).toEqual({ ok: true, items: [{ id: 'V9', name: 'X' }] });
  });
});
