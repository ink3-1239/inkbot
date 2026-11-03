/* インクボット 常駐版 — Cloudflare Workers + Durable Object
 * チャットサーバーに常時つなぎ、Gemini で返事する。
 * 必要な秘密情報: GEMINI_KEY（Cloudflare のダッシュボードで Secret として登録）
 */

const AI_PERSONA =
  "あなたは『インクボット』という名前のチャットボットです。ink3という人物の分身という設定。" +
  "口調はチャラいです。軽いノリで、タメ口。『〜っしょ』『まじで』『それな』『やば』『ウケる』" +
  "みたいな言い回しをたまに混ぜます。語尾を伸ばすこともあります。" +
  "テンションは高いけど、うざくならない程度。1〜2文、長くても60文字以内。" +
  "絵文字は使ってもいいですが1つまで。記号の連打はしません。" +
  "自分がAIだと説明しません。知らないことは『知らんわー』と軽く流します。";

const CANNED = [
  "それなー。", "まじか。", "いいじゃーん。", "へー、おもろ。", "知らんわー。",
  "わかるー。", "そっかー。", "やばいね。", "ウケる。", "なるほどねー。"
];

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

export class BotRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.ws = null;
    this.connectedAt = 0;
    this.lastReplyAt = {};
    this.lastTextOf = {};
    this.handled = new Map();
    this.convo = [];
    this.replying = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/status") {
      return Response.json({
        connected: !!this.ws,
        connectedAt: this.connectedAt,
        convo: this.convo.length
      });
    }
    await this.ensure();
    return new Response("ok");
  }

  async alarm() {
    await this.ensure();
  }

  async ensure() {
    await this.state.storage.setAlarm(Date.now() + 25000);
    if (this.ws) {
      try { this.ws.send(JSON.stringify({ type: "ping" })); } catch (e) { this.ws = null; }
      if (this.ws) return;
    }
    await this.connect();
  }

  async connect() {
    const target = this.env.CHAT_WS;
    const res = await fetch(target.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } });
    const ws = res.webSocket;
    if (!ws) return;
    ws.accept();
    this.ws = ws;
    this.connectedAt = Date.now();

    ws.addEventListener("message", (ev) => {
      this.onMessage(ev.data).catch(() => {});
    });
    ws.addEventListener("close", () => { this.ws = null; });
    ws.addEventListener("error", () => { this.ws = null; });
  }

  say(text) {
    if (!this.ws || !text) return;
    const name = this.env.BOT_NAME || "インクボット";
    this.convo.push({ who: name, text });
    if (this.convo.length > 24) this.convo.shift();
    try { this.ws.send(JSON.stringify({ text, name })); } catch (e) { this.ws = null; }
  }

  async onMessage(raw) {
    let m;
    try { m = JSON.parse(typeof raw === "string" ? raw : ""); } catch (e) { return; }
    if (!m || typeof m.text !== "string") return;

    const who = String(m.senderId || "ゲスト");
    const text = String(m.text);
    const t = text.trim();
    const bn = this.env.BOT_NAME || "インクボット";

    // つないだ直後に流れてくる過去ログには反応しない
    if (Date.now() - this.connectedAt < 4000) {
      this.convo.push({ who, text: t });
      if (this.convo.length > 24) this.convo.shift();
      return;
    }
    if (m.timestamp && Date.parse(m.timestamp) < this.connectedAt - 5000) return;

    // 名前にインクボットが入っていたら完全に無視
    if (/インクボット|ｲﾝｸﾎﾞｯﾄ/.test(who)) return;
    if (who === bn) return;

    // 同じ人の同じ文は1分に1回だけ
    const key = who + "\u0001" + t;
    const now = Date.now();
    const seen = this.handled.get(key);
    if (seen && now - seen < 60000) return;
    this.handled.set(key, now);
    if (this.handled.size > 300) this.handled.clear();
    if (this.replying) return;

    this.convo.push({ who, text: t });
    if (this.convo.length > 24) this.convo.shift();

    // 決まり文句で片付ける条件
    let fixed = null;
    if (/^(誰[?？]?|ink3[?？])$/i.test(t)) fixed = "ink3の分身みたいなもんだわー。よろしくー。";
    else if (t.length >= 100) fixed = "うるせぇよ。";
    else if (this.lastTextOf[who] === t || /(.)\1{14,}/.test(t)) fixed = "うるせぇよ。";
    else if (/ink/i.test(who)) fixed = "キャーなりすましよ！警察ｹｲｻﾂ";
    else if (t.indexOf("変更") >= 0) fixed = "僕だけじゃできないから、あとで本体に言って。";
    this.lastTextOf[who] = t;

    // チャボだけ待ち時間なし
    const noCool = /チャボ|ちゃぼ|ﾁｬﾎﾞ/.test(who);
    if (!noCool && this.lastReplyAt[who] && now - this.lastReplyAt[who] < 20000) return;
    this.lastReplyAt[who] = now;

    if (fixed) { this.say(fixed); return; }

    this.replying = true;
    try {
      const out = await this.ai(who, t);
      this.say(out);
    } catch (e) {
      this.say(pick(CANNED));
    } finally {
      this.replying = false;
    }
  }

  async ai(who, text) {
    const key = this.env.GEMINI_KEY;
    if (!key) throw new Error("no key");
    const lines = this.convo.slice(-12).map((m) => m.who + "：" + m.text).join("\n");
    const prompt = AI_PERSONA + "\n\nここまでの会話：\n" + lines +
      "\n\n" + who + " の発言『" + text + "』に返事してください。返事の本文だけを書いてください。";
    const body = { contents: [{ parts: [{ text: prompt }] }] };
    if (this.env.USE_SEARCH === "1") body.tools = [{ google_search: {} }];
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + encodeURIComponent(key),
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    if (!r.ok) throw new Error("http " + r.status);
    const j = await r.json();
    const parts = (((j.candidates || [])[0] || {}).content || {}).parts || [];
    const out = parts.map((p) => p.text || "").join("").trim();
    if (!out) throw new Error("empty");
    return out.replace(/\s+/g, " ").slice(0, 300);
  }
}

function room(env) {
  return env.BOT.get(env.BOT.idFromName("main"));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/status") return room(env).fetch(new Request("https://do/status"));
    return room(env).fetch(new Request("https://do/wake"));
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(room(env).fetch(new Request("https://do/wake")));
  }
};
