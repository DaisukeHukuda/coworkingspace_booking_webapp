import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { getMailTemplates, renderTemplate, MAIL_TEMPLATE_TYPES } from '../src/core/mailTemplates';
import { saveSettings } from '../src/core/settings';

describe('mail templates', () => {
  it('renderTemplate はタグを置換し、同一タグ複数回もすべて置換し、未知タグはそのまま残す', () => {
    const out = renderTemplate('{会員名}様 {日時} / {会員名} / {未知タグ}', {
      '会員名': '山田',
      '日時': '2026-08-01 10:00〜13:00'
    });
    expect(out).toBe('山田様 2026-08-01 10:00〜13:00 / 山田 / {未知タグ}');
  });

  it('getMailTemplates は未設定なら全種とも空文字を返す', async () => {
    const t = await getMailTemplates(env.DB);
    for (const type of MAIL_TEMPLATE_TYPES) {
      expect(t[type]).toEqual({ subject: '', body: '' });
    }
  });

  it('保存したテンプレートを種類ごとに読み出せる', async () => {
    await saveSettings(env.DB, [
      { key: 'mail_tpl_confirmed_subject', value: '確定: {日時}' },
      { key: 'mail_tpl_confirmed_body', value: '{会員名}様、確定です' },
      { key: 'mail_tpl_requested_member_subject', value: '受付: {日時}' }
    ]);
    const t = await getMailTemplates(env.DB);
    expect(t.confirmed).toEqual({ subject: '確定: {日時}', body: '{会員名}様、確定です' });
    expect(t.requested_member).toEqual({ subject: '受付: {日時}', body: '' });
    expect(t.declined).toEqual({ subject: '', body: '' }); // 他の種類は影響なし
  });
});
