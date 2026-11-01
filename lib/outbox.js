'use strict';
/** 油猴桥接的消息队列：软件 ↔ 网页 之间的收发管道 */

class Outbox {
  constructor() {
    this.seq = 0;
    this.items = [];          // 待网页取走的指令
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.waiters = [];        // 挂起的长轮询
    this.lastSeen = 0;
    this.lastHost = '';
  }

  /**
   * 是否在线。注意：网页端用 18 秒长轮询，等待期间服务端收不到新请求，
   * lastSeen 会变旧，所以阈值必须大于长轮询的 hold 时间，否则会误判掉线。
   */
  get connected() {
    return Date.now() - this.lastSeen < 25000;
  }

  /** 网页端长轮询：有指令立刻给，没有就挂起（最长 holdMs） */
  poll(since, host, holdMs = 18000) {
    this.lastSeen = Date.now();
    if (host) this.lastHost = host;

    const sinceNum = Number(since);
    // 首次连接：只回报当前进度，不重放历史指令
    if (!Number.isFinite(sinceNum) || sinceNum < 0) {
      return Promise.resolve({ ok: true, seq: this.seq, msg: null, init: true });
    }
    const hit = this.items.find((it) => it.seq > sinceNum);
    if (hit) {
      return Promise.resolve({ ok: true, seq: this.seq, msg: { id: hit.id, seq: hit.seq, text: hit.text } });
    }
    return new Promise((resolve) => {
      const w = { resolve, seq: this.seq, timer: null };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve({ ok: true, seq: this.seq, msg: null });
      }, holdMs);
      this.waiters.push(w);
    });
  }

  _flush() {
    const ws = this.waiters.splice(0);
    for (const w of ws) {
      clearTimeout(w.timer);
      const hit = this.items.find((it) => it.seq > w.seq);
      w.resolve({
        ok: true,
        seq: this.seq,
        msg: hit ? { id: hit.id, seq: hit.seq, text: hit.text } : null,
      });
    }
  }

  /** 发一条指令给网页，等它回话 */
  send(text, timeoutMs = 240000) {
    this.seq += 1;
    const id = 'm' + this.seq + '-' + Math.random().toString(36).slice(2, 7);
    this.items.push({ id, seq: this.seq, text });
    if (this.items.length > 30) this.items = this.items.slice(-30);
    this._flush();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this._drop(id);
        reject(new Error('等待网页 AI 回复超时（网页没在跑，或脚本被暂停了）'));
      }, timeoutMs);

      // 断线看门狗：网页端长时间没心跳就别干等
      const wd = setInterval(() => {
        if (!this.pending.has(id)) { clearInterval(wd); return; }
        const age = Date.now() - this.lastSeen;
        if (this.lastSeen && age < 32000) return;
        clearInterval(wd);
        clearTimeout(timer);
        this._drop(id);
        reject(new Error(
          this.lastSeen
            ? '网页端断开了（已经 ' + Math.round(age / 1000) + ' 秒没有心跳）—— 请确认浏览器标签页还开着、油猴脚本没被暂停'
            : '网页端从来没连上过 —— 油猴脚本没装/没启用，或者没打开 chat.deepseek.com'
        ));
      }, 2000);

      this.pending.set(id, { resolve, reject, timer, wd });
    });
  }

  _drop(id) {
    const p = this.pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    if (p.wd) clearInterval(p.wd);
    this.pending.delete(id);
  }

  reply(id, payload) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    if (p.wd) clearInterval(p.wd);
    this.pending.delete(id);
    this.lastSeen = Date.now();
    if (payload && payload.error) p.reject(new Error(payload.error));
    else p.resolve(String((payload && payload.text) || ''));
    return true;
  }

  /** 中止时清理所有挂起 */
  abortAll(reason) {
    for (const id of Array.from(this.pending.keys())) {
      const p = this.pending.get(id);
      clearTimeout(p.timer);
      if (p.wd) clearInterval(p.wd);
      this.pending.delete(id);
      try { p.reject(new Error(reason || '已中止')); } catch (e) {}
    }
    this.items = [];
    this._flush();
  }

  /** 新一轮任务开始：丢掉上一轮没被取走的指令，避免网页端拿到过期内容 */
  clearStale() {
    this.items = [];
  }

  get waitingCount() {
    return this.pending.size;
  }
}

module.exports = { Outbox };
