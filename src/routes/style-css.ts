// UIリスタイル Task R1: デザイントークン・共通パーツ・管理シェル・ログイン画面（§1〜§3, §5-1, §12）
// 会員ページ・ダッシュボード・各管理ページの画面固有スタイルは後続タスク（R2〜R5）で置換予定。
// 旧スタイルはファイル末尾の「旧スタイル」マーカー以降に維持している。
export const STYLE_CSS = `
:root{
  /* 面 */
  --canvas:#ffffff;        /* カード地 */
  --paper:#f6f4ee;         /* 画面の地（生成り） */
  --paper-2:#faf9f5;       /* テーブルのゼブラ */
  --paper-3:#efece5;       /* 過去日セル */
  --paper-4:#e8e4da;       /* 停止日・満席セル */

  /* 文字 */
  --ink:#131619;
  --ink-2:#3b424b;
  --ink-3:#6c727b;
  --ink-4:#a7a294;         /* 無効・過去 */

  /* ブランド */
  --navy:#16294f;          /* 帯・見出し・主ボタン */
  --navy-2:#22345c;        /* hover */
  --navy-ink:#0e1a34;      /* active */
  --navy-nav:#2b3f68;      /* ナビの現在地 */
  --cobalt:#0050b0;        /* リンク */
  --cobalt-2:#0a63cf;      /* リンク hover */
  --torch:#cdae74;         /* 「次回のご利用」カードの地（灯りの色） */

  /* 状態 */
  --ok:#3f7d4e;   --ok-bg:#e4efe4;   --ok-bd:#b7d3bd;   --ok-fg:#2e5c39;
  --wait:#c98a2b; --wait-bg:#f6ecd6; --wait-bd:#e0c48a; --wait-fg:#7d5410;
  --ng:#b23a34;   --ng-bg:#f6e0dd;   --ng-bd:#d9a9a3;   --ng-fg:#8f2b26;
  --off-bg:#edeae1; --off-bd:#d8d4c8; --off-fg:#6c727b;
  --type-m-bg:#e6ecf5; --type-m-bd:#b6c6de; --type-m-fg:#1f3a63; /* 月額会員 */

  /* 罫 */
  --line:#131619;          /* カード外周・見出し下の主罫（1px） */
  --line-2:#eeebe2;        /* 行間の細罫 */
  --line-3:#d8d4c8;        /* 静かな仕切り */
  --line-4:#b9b3a3;        /* 入力の副次的な枠 */

  /* 書体 */
  --font-sans:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Hiragino Kaku Gothic ProN","Noto Sans JP","Yu Gothic Medium",Meiryo,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;

  --focus:0 0 0 3px rgba(0,80,176,.35);
}
*, *::before, *::after { box-sizing: border-box; }
* { border-radius: 0; }   /* 角丸はゼロが既定。丸いのは状態ドットだけ */

/* ==== ベース ==== */
body { margin: 0; font: 400 13px/1.8 var(--font-sans); letter-spacing: .03em; color: var(--ink); background: var(--paper); }
a { color: var(--cobalt); }
a:hover { color: var(--cobalt-2); }
:focus-visible { box-shadow: var(--focus); outline: none; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

/* ==== 見出し・アイブロー（§2） ==== */
.eyebrow { display: block; font: 700 10px var(--font-mono); letter-spacing: .2em; color: var(--ink-3); text-transform: uppercase; }
.page-head { margin-bottom: 16px; }
.page-head h1 { margin: 3px 0 0; font: 900 27px/1.25 var(--font-sans); letter-spacing: .02em; color: var(--ink); }
.page-head .sub { display: inline-block; font: 400 12px/1.5 var(--font-mono); letter-spacing: .06em; color: var(--ink-3); }
h2 { font: 900 16px/1.3 var(--font-sans); letter-spacing: .03em; color: var(--ink); margin: 28px 0 12px; }

/* ==== 共通パーツ：罫線カード（§3-1） ==== */
.card { background: var(--canvas); border: 1px solid var(--line); box-shadow: none; }
.card-pad { padding: 12px 14px; }

/* ==== 共通パーツ：ボタン（§3-2） ==== */
.btn { display: inline-block; padding: 11px 22px; border: 1px solid var(--navy); background: #fff; color: var(--navy); font: 700 13px/1 var(--font-sans); letter-spacing: .06em; text-align: center; cursor: pointer; text-decoration: none; }
.btn:hover { background: #f2f4f8; }
.btn-primary { background: var(--navy); border-color: var(--navy); color: #fff; }
.btn-primary:hover { background: var(--navy-2); border-color: var(--navy-2); }
.btn-primary:active { background: var(--navy-ink); border-color: var(--navy-ink); }
.btn-danger { background: #fff; border-color: var(--ng); color: var(--ng); }
.btn-danger:hover { background: #fbeceb; }
.btn[disabled] { background: var(--paper-3); border-color: var(--line-3); color: var(--ink-4); cursor: not-allowed; }
.btn-sm { padding: 7px 12px; font-size: 12px; letter-spacing: .04em; }
.btn-lg { padding: 16px 0; font-size: 15px; letter-spacing: .08em; }
.btn-block { display: block; width: 100%; }
.btn-onnavy { background: transparent; border-color: rgba(255,255,255,.55); color: #fff; }
.btn-onnavy:hover { background: rgba(255,255,255,.12); }

/* ==== 共通パーツ：状態バッジ・種別バッジ（§3-3, §3-4） ==== */
.badge { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border: 1px solid transparent; font: 700 11.5px/1.6 var(--font-sans); letter-spacing: .04em; background: var(--paper-3); color: var(--ink-2); }
.badge-monthly { background: var(--type-m-bg); border-color: var(--type-m-bd); color: var(--type-m-fg); font-size: 11px; }
.badge-ticket { background: var(--wait-bg); border-color: var(--wait-bd); color: var(--wait-fg); font-size: 11px; }
.badge-pending { background: var(--wait-bg); border-color: var(--wait-bd); color: var(--wait-fg); }
.badge-pending::before { content: "○"; font-size: 9px; }
.badge-confirmed { background: var(--ok-bg); border-color: var(--ok-bd); color: var(--ok-fg); }
.badge-confirmed::before { content: "●"; font-size: 9px; }
.badge-declined { background: var(--ng-bg); border-color: var(--ng-bd); color: var(--ng-fg); }
.badge-declined::before { content: "×"; font-size: 9px; }
.badge-cancelled { background: var(--off-bg); border-color: var(--off-bd); color: var(--off-fg); }
.badge-cancelled::before { content: "−"; font-size: 9px; }
.badge-on { background: var(--ok-bg); border-color: var(--ok-bd); color: var(--ok-fg); }
.badge-on::before { content: "●"; font-size: 9px; }
.badge-off { background: var(--off-bg); border-color: var(--off-bd); color: var(--off-fg); }
.badge-off::before { content: "−"; font-size: 9px; }
.badge-warn { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border: 1px solid var(--wait-bd); background: var(--wait-bg); color: var(--wait-fg); font: 700 10.5px/1.5 var(--font-sans); letter-spacing: .03em; }

/* ==== 共通パーツ：メッセージ帯（§3-5） ==== */
.msg-ok, .msg-error { display: flex; align-items: flex-start; gap: 9px; margin: 0 0 16px; padding: 12px 14px; font: 400 12.5px/1.7 var(--font-sans); letter-spacing: .03em; }
.msg-ok { background: var(--ok-bg); border-bottom: 1px solid #9dbfa6; color: #245030; }
.msg-ok::before { content: "✓"; flex: none; width: 18px; height: 18px; border-radius: 50%; background: var(--ok); color: #fff; font: 700 11px/18px var(--font-sans); text-align: center; }
.msg-error { background: var(--ng-bg); border: 1px solid var(--ng-bd); color: var(--ng-fg); }
.msg-error::before { content: "!"; flex: none; width: 16px; height: 16px; background: var(--ng); color: #fff; font: 700 11px/16px var(--font-sans); text-align: center; }

/* ==== 管理シェル（§5-1） ==== */
.admin-bar { background: var(--navy); min-height: 56px; display: flex; align-items: center; gap: 26px; padding: 10px 24px; flex-wrap: wrap; }
.admin-logo { display: flex; flex-direction: column; text-decoration: none; }
.admin-logo .t1 { font: 900 17px/1 var(--font-sans); letter-spacing: .1em; color: #fff; }
.admin-logo .t2 { margin-top: 2px; font: 400 7.5px/1.5 var(--font-mono); letter-spacing: .26em; color: rgba(255,255,255,.6); }
.admin-nav { display: flex; gap: 2px; flex: 1; flex-wrap: wrap; }
.admin-nav a { padding: 8px 13px; font: 600 13.5px/1.4 var(--font-sans); letter-spacing: .04em; color: #fff; text-decoration: none; }
.admin-nav a:hover { background: rgba(255,255,255,.12); }
.admin-nav a.is-current { background: var(--navy-nav); }
.admin-logout { flex: none; }
.page { background: var(--paper); padding: 22px 24px 30px; }

@media (max-width: 820px) {
  .admin-bar { height: auto; }
  .admin-nav { flex-wrap: wrap; }
}

/* ==== ログイン画面（§12） ==== */
.login-shell { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; background: var(--paper); }
.login-box { width: 100%; max-width: 390px; border: 3px solid var(--navy); background: #fff; }
.login-brand { background: var(--navy); padding: 22px 24px 20px; text-align: center; }
.login-brand .t1 { font: 900 26px/1 var(--font-sans); letter-spacing: .14em; color: #fff; }
.login-brand .t2 { margin-top: 5px; font: 400 9px/1.6 var(--font-mono); letter-spacing: .32em; color: rgba(255,255,255,.7); }
.login-body { padding: 26px 24px 28px; }
.login-body .msg-error { margin: 0 0 18px; }
.login-role { margin: 0 0 18px; font: 700 12px/1.7 var(--font-sans); letter-spacing: .06em; color: var(--ink-2); text-align: center; }
.login-field label { display: block; margin-bottom: 5px; font: 700 11.5px/1.6 var(--font-sans); letter-spacing: .06em; color: var(--ink-2); }
.login-field input { display: block; width: 100%; height: 46px; padding: 0 12px; border: 1px solid var(--line); font: 600 16px var(--font-mono); letter-spacing: .3em; color: var(--ink); background: #fff; }
.login-submit { display: block; width: 100%; margin-top: 16px; padding: 15px 0; border: none; background: var(--navy); text-align: center; font: 900 14.5px/1 var(--font-sans); letter-spacing: .1em; color: #fff; cursor: pointer; }
.login-submit:hover { background: var(--navy-2); }
.login-submit:active { background: var(--navy-ink); }
.login-note { margin: 16px 0 0; padding-top: 14px; border-top: 1px solid var(--line-2); font: 400 11.5px/1.8 var(--font-sans); letter-spacing: .03em; color: var(--ink-3); text-align: center; }

/* ==== 旧スタイル（後続タスクで置換・削除予定） ==== */
.site-header { background: #1a2a4a; color: #fff; }
.site-header .inner { max-width: 960px; margin: 0 auto; padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.brand { font-weight: 700; text-decoration: none; color: inherit; }
.brand small { display: block; font-size: 10px; letter-spacing: .15em; opacity: .7; font-weight: 400; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.field label { font-size: 13px; color: #565f75; }
.field input, .field select, .field textarea { padding: 8px 10px; border: 1px solid #c6c6bb; border-radius: 6px; font-size: 15px; background: #fff; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: end; }
.check { font-size: 14px; }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dcdcd2; border-radius: 10px; overflow: hidden; }
.tbl th, .tbl td { padding: 10px 12px; border-bottom: 1px solid #ecece4; text-align: left; font-size: 14px; vertical-align: middle; }
.tbl th { background: #f8f8f3; font-size: 12px; color: #565f75; }
.row-muted { opacity: .5; }
.copy-link input { width: 100%; min-width: 260px; font-size: 12px; padding: 4px 6px; border: 1px solid #c6c6bb; border-radius: 4px; color: #565f75; }
.muted { color: #7a8299; }
.small { font-size: 13px; }
.actions form { display: inline; }
.member-wrap { max-width: 640px; margin: 0 auto; padding: 24px 16px 64px; }
.cal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.cal-head h2 { margin: 0; }
.cal { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dcdcd2; border-radius: 10px; overflow: hidden; }
.cal th { padding: 6px 0; font-size: 12px; color: #565f75; background: #f8f8f3; text-align: center; }
.cal th.sun, .cal td.sun .day-num { color: #b0453a; }
.cal th.sat, .cal td.sat .day-num { color: #1a5f9e; }
.cal td { border: 1px solid #ecece4; height: 52px; width: 14.28%; vertical-align: top; padding: 0; text-align: center; }
.cal td a, .cal td .day-off { display: block; height: 100%; padding: 6px 4px; text-decoration: none; color: inherit; font-size: 13px; }
.cal td a:hover { background: #eef2fa; }
.cal td.selected a { background: #1a2a4a; color: #fff; }
.cal td .day-off { color: #b8b8ad; }
.cal td .mark { display: block; font-size: 10px; margin-top: 2px; }
.cal td .mark-x { font-size: 16px; font-weight: 700; line-height: 1; }
.slot-list { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
.slot-row { display: flex; align-items: center; gap: 10px; font-size: 15px; }
.req-when { font-weight: 700; }
.cal-dot { width: 6px; height: 6px; border-radius: 50%; }
.cal td .cal-dot { display: block; margin: 3px auto 0; }
.cal-legend { display: flex; gap: 16px; align-items: center; margin: 8px 0 0; color: #565f75; }
.legend-item { display: inline-flex; align-items: center; gap: 5px; }
.legend-item .cal-dot { display: inline-block; }
.dot-pending { background: #d97b1f; }
.dot-confirmed { background: #1c6b34; }
.dot-declined { background: #b0453a; }
.dash-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 8px; }
.dash-card { display: block; background: #fff; border: 1px solid #dcdcd2; border-radius: 10px; padding: 14px 16px; text-decoration: none; color: inherit; }
.dash-card .dash-num { display: block; font-size: 28px; font-weight: 700; line-height: 1.2; }
.dash-card .dash-label { font-size: 12px; color: #565f75; }
.dash-warn { border-color: #d97b1f; background: #fdf3e3; }
.dash-warn .dash-num { color: #8a4b12; }
`;
