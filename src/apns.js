import { connect } from "node:http2";
import { createPrivateKey, sign } from "node:crypto";

const HOSTS = { production: "https://api.push.apple.com", sandbox: "https://api.sandbox.push.apple.com" };
const TOKEN_MS = 45 * 60 * 1000;
const b64url = (value) => Buffer.from(value).toString("base64url");

/**
 * Apple Push Notification service with a token-based key (.p8): one ES256 JWT, renewed every 45 minutes,
 * on one HTTP/2 session per environment. Development builds of the iOS app register with the sandbox.
 */
export class Apns {
  constructor({ key, keyId, teamId, topic, timeoutMs = 15000, hosts = HOSTS }) {
    this.key = createPrivateKey(key);
    Object.assign(this, { keyId, teamId, topic, timeoutMs, hosts, sessions: new Map(), token: null });
  }

  jwt(now = Date.now()) {
    if (this.token && now - this.token.at < TOKEN_MS) return this.token.value;
    const unsigned = `${b64url(JSON.stringify({ alg: "ES256", kid: this.keyId }))}.${b64url(JSON.stringify({ iss: this.teamId, iat: Math.floor(now / 1000) }))}`;
    const signature = sign("sha256", Buffer.from(unsigned), { key: this.key, dsaEncoding: "ieee-p1363" });
    this.token = { at: now, value: `${unsigned}.${b64url(signature)}` };
    return this.token.value;
  }

  session(environment) {
    const open = this.sessions.get(environment);
    if (open && !open.closed && !open.destroyed) return open;
    const session = connect(this.hosts[environment] || this.hosts.production);
    session.on("error", () => this.sessions.delete(environment));
    session.on("goaway", () => this.sessions.delete(environment));
    session.unref();
    this.sessions.set(environment, session);
    return session;
  }

  /** Sends one alert; answers APNs' status and reason (410 or BadDeviceToken mean the token is gone). */
  send(deviceToken, { title, body = "", tag = "", data = {} }, { environment = "production" } = {}) {
    const payload = JSON.stringify({ aps: { alert: { title: String(title).slice(0, 80), body: String(body).slice(0, 400) }, sound: "default", ...(tag ? { "thread-id": tag.slice(0, 64) } : {}) }, ...data });
    return new Promise((resolve) => {
      let request;
      try {
        request = this.session(environment).request({
          ":method": "POST", ":path": `/3/device/${deviceToken}`, authorization: `bearer ${this.jwt()}`,
          "apns-topic": this.topic, "apns-push-type": "alert", "apns-priority": "10", "content-type": "application/json",
          ...(tag ? { "apns-collapse-id": tag.slice(0, 64) } : {}),
        });
      } catch (error) { resolve({ status: 0, reason: error.message }); return; }
      let status = 0, text = "";
      const timer = setTimeout(() => { request.close(); resolve({ status: 0, reason: "timeout" }); }, this.timeoutMs);
      request.on("response", (headers) => { status = Number(headers[":status"]) || 0; });
      request.setEncoding("utf8");
      request.on("data", (chunk) => { text += chunk; });
      request.on("end", () => { clearTimeout(timer); let reason = ""; try { reason = JSON.parse(text || "{}").reason || ""; } catch {} resolve({ status, reason }); });
      request.on("error", (error) => { clearTimeout(timer); resolve({ status: 0, reason: error.message }); });
      request.end(payload);
    });
  }

  close() { for (const session of this.sessions.values()) session.close(); this.sessions.clear(); }
}

/** Whether APNs says the device token will never work again. */
export const goneToken = ({ status, reason }) => status === 410 || (status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(reason));
