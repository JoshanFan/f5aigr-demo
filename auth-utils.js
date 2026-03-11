const DEMO_USERNAME = "admin";
const DEMO_PASSWORD = "F5aidemo";

export function isValidDemoLogin(username, password) {
  return String(username || "").trim() === DEMO_USERNAME && String(password || "") === DEMO_PASSWORD;
}
