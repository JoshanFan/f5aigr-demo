const DEMO_USERNAME = "user";
const DEMO_PASSWORD = "demo";

export function isValidDemoLogin(username, password) {
  return String(username || "").trim() === DEMO_USERNAME && String(password || "") === DEMO_PASSWORD;
}
