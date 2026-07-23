// 会員専用リンクのトークン。20バイト乱数（160bit）を40桁hexで表す（設計書 §6/§10）
export function newMemberToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(20))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
