/* インクボット 常駐版 — Render 用
 * チャットサーバーに常時つなぎ、Gemini で返事する。
 * 環境変数: GEMINI_KEY（必須）, BOT_NAME, CHAT_WS, USE_SEARCH
 */
const http = require("http");
const WebSocket = require("ws");

const BOT_NAME = process.env.BOT_NAME || "インクボット";
const CHAT_WS = process.env.CHAT_WS || "wss://knj48-ver-chatsystem.onrender.com";
const USE_SEARCH = (process.env.USE_SEARCH || "1") === "1";
const GEMINI_KEY = process.env.GEMINI_KEY || "";

const AI_PERSONA =
  "あなたは『インクボット』という名前のチャットボットです。ink3という人物の分身という設定。" +
  "口調はチャラいです。軽いノリで、タメ口。『〜っしょ』『まじで』『それな』『やば』『ウケる』" +
  "みたいな言い回しをたまに混ぜます。語尾を伸ばすこともあります。" +
  "テンションは高いけど、うざくならない程度。1〜2文、長くても60文字以内。" +
  "絵文字は使ってもいいですが1つまで。記号の連打はしません。" +
  "自分がAIだと説明しません。知らないことは『知らんわー』と軽く流します。";

const CANNED = ["それなー。","まじか。","いいじゃーん。","へー、おもろ。","知らんわー。","わかるー。","そっかー。","やばいね。","ウケる。","なるほどねー。"];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

let ws = null, connectedAt = 0, replying = false;
let convo = [], handled = new Map(), lastReplyAt = {}, lastTextOf = {};
let sent = 0, got = 0, lastError = "";

function remember(who, text) {
  convo.push({ who, text });
  if (convo.length > 24) convo.shift();
}

function say(text) {
  if (!ws || ws.readyState !== WebSocket.OPEN || !text) return;
  remember(BOT_NAME, text);
  try { ws.send(JSON.stringify({ text, name: BOT_NAME })); sent++; } catch (e) { lastError = String(e.message); }
}

async function ai(who, text) {
  if (!GEMINI_KEY) throw new Error("キーが設定されていません");
  const lines = convo.slice(-12).map((m) => m.who + "：" + m.text).join("\n");
  const prompt = AI_PERSONA + "\n\nここまでの会話：\n" + lines +
    "\n\n" + who + " の発言『" + text + "』に返事してください。返事の本文だけを書いてください。";
  const body = { contents: [{ parts: [{ text: prompt }] }] };
  if (USE_SEARCH) body.tools = [{ google_search: {} }];
  const r = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(GEMINI_KEY),
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
  );
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
  const out = parts.map((p) => p.text || "").join("").trim();
  if (!out) throw new Error("空の返事");
  return out.replace(/\s+/g, " ").slice(0, 300);
}

async function onMessage(raw) {
  let m;
  try { m = JSON.parse(raw.toString()); } catch (e) { return; }
  if (!m || typeof m.text !== "string") return;
  got++;

  const who = String(m.senderId || "ゲスト");
  const t = String(m.text).trim();

  // つないだ直後に流れてくる過去ログには返事しない
  if (Date.now() - connectedAt < 4000) { remember(who, t); return; }
  if (m.timestamp && Date.parse(m.timestamp) < connectedAt - 5000) return;

  if (/インクボット|ｲﾝｸﾎﾞｯﾄ/.test(who)) return;
  if (who === BOT_NAME) return;

  const now = Date.now();
  const key = who + "\u0001" + t;
  if (handled.get(key) && now - handled.get(key) < 60000) return;
  handled.set(key, now);
  if (handled.size > 300) handled.clear();
  if (replying) return;

  remember(who, t);

  let fixed = null;
  if (/^(誰[?？]?|ink3[?？])$/i.test(t)) fixed = "ink3の分身みたいなもんだわー。よろしくー。";
  else if (t.length >= 100) fixed = "うるせぇよ。";
  else if (lastTextOf[who] === t || /(.)\1{14,}/.test(t)) fixed = "うるせぇよ。";
  else if (/ink/i.test(who)) fixed = "キャーなりすましよ！警察ｹｲｻﾂ";
  else if (t.indexOf("変更") >= 0) fixed = "僕だけじゃできないから、あとで本体に言って。";
  lastTextOf[who] = t;

  const noCool = /チャボ|ちゃぼ|ﾁｬﾎﾞ/.test(who);
  if (!noCool && lastReplyAt[who] && now - lastReplyAt[who] < 20000) return;
  lastReplyAt[who] = now;

  if (fixed) { say(fixed); return; }

  replying = true;
  try { say(await ai(who, t)); }
  catch (e) { lastError = String(e.message); say(pick(CANNED)); }
  finally { replying = false; }
}

function connect() {
  try { if (ws) ws.terminate(); } catch (e) {}
  ws = new WebSocket(CHAT_WS);
  ws.on("open", () => { connectedAt = Date.now(); console.log("つながりました"); });
  ws.on("message", (d) => { onMessage(d).catch((e) => { lastError = String(e.message); }); });
  ws.on("close", () => { ws = null; console.log("切れました。5秒後に再接続"); setTimeout(connect, 5000); });
  ws.on("error", (e) => { lastError = String(e.message); });
}
connect();
setInterval(() => {
  if (!ws || ws.readyState !== WebSocket.OPEN) connect();
  else { try { ws.ping(); } catch (e) {} }
}, 25000);

const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({
    connected: !!ws && ws.readyState === WebSocket.OPEN,
    connectedAt: connectedAt ? new Date(connectedAt).toISOString() : null,
    received: got, sent, hasKey: !!GEMINI_KEY, search: USE_SEARCH, lastError
  }, null, 2));
}).listen(port, () => console.log("待受 " + port));
