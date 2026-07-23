// ステップ①の最小スタイル。会員向けUIの本格的なデザインはステップ②で行う
export const STYLE_CSS = `
*, *::before, *::after { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Noto Sans JP", sans-serif; color: #1a2233; background: #f4f4ef; }
a { color: #1a3a6b; }
.site-header { background: #1a2a4a; color: #fff; }
.site-header .inner { max-width: 960px; margin: 0 auto; padding: 10px 16px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.brand, .brand-lg { font-weight: 700; text-decoration: none; color: inherit; }
.brand small, .brand-lg small { display: block; font-size: 10px; letter-spacing: .15em; opacity: .7; font-weight: 400; }
.brand-lg { font-size: 22px; }
.nav { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
.nav a { color: #dfe6f2; text-decoration: none; padding: 6px 10px; border-radius: 6px; font-size: 14px; }
.nav a.is-active, .nav a:hover { background: rgba(255,255,255,.14); color: #fff; }
.page { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
.page-head { margin-bottom: 20px; }
.page-head .eyebrow { font-size: 11px; letter-spacing: .18em; color: #7a8299; text-transform: uppercase; }
.page-head h1 { margin: 2px 0 0; font-size: 24px; }
.page-head .sub { font-size: 13px; }
h2 { font-size: 18px; margin: 32px 0 12px; }
.card { background: #fff; border: 1px solid #dcdcd2; border-radius: 10px; }
.card-pad { padding: 20px; }
.field { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
.field label { font-size: 13px; color: #565f75; }
.field input, .field select, .field textarea { padding: 8px 10px; border: 1px solid #c6c6bb; border-radius: 6px; font-size: 15px; background: #fff; }
.form-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: end; }
.check { font-size: 14px; }
.btn { display: inline-block; padding: 7px 14px; border: 1px solid #1a2a4a; border-radius: 6px; background: #fff; color: #1a2a4a; font-size: 14px; cursor: pointer; text-decoration: none; }
.btn-primary { background: #1a2a4a; color: #fff; }
.btn-sm { padding: 4px 10px; font-size: 13px; }
.btn-lg { padding: 10px 18px; font-size: 16px; }
.btn-block { width: 100%; }
.btn-onnavy { border-color: rgba(255,255,255,.5); background: transparent; color: #fff; }
.tbl-wrap { overflow-x: auto; }
.tbl { width: 100%; border-collapse: collapse; background: #fff; border: 1px solid #dcdcd2; border-radius: 10px; overflow: hidden; }
.tbl th, .tbl td { padding: 10px 12px; border-bottom: 1px solid #ecece4; text-align: left; font-size: 14px; vertical-align: middle; }
.tbl th { background: #f8f8f3; font-size: 12px; color: #565f75; }
.row-muted { opacity: .5; }
.badge { display: inline-block; padding: 2px 8px; border-radius: 99px; font-size: 12px; background: #e8e8df; }
.badge-monthly { background: #dbe7fb; color: #1a3a6b; }
.badge-ticket { background: #fdeacc; color: #7a4b12; }
.badge-on { background: #dcf2e0; color: #1c6b34; }
.badge-off { background: #fbdddd; color: #8f1f1f; }
.copy-link input { width: 100%; min-width: 260px; font-size: 12px; padding: 4px 6px; border: 1px solid #c6c6bb; border-radius: 4px; color: #565f75; }
.msg-ok { background: #dcf2e0; color: #1c6b34; padding: 10px 14px; border-radius: 8px; }
.msg-error { background: #fbdddd; color: #8f1f1f; padding: 10px 14px; border-radius: 8px; }
.muted { color: #7a8299; }
.small { font-size: 13px; }
.actions form { display: inline; }
.login-wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.login-card { width: 100%; max-width: 360px; background: #fff; border: 1px solid #dcdcd2; border-radius: 12px; padding: 32px 28px; text-align: center; }
.member-wrap { max-width: 560px; margin: 0 auto; padding: 24px 16px 64px; }
`;
