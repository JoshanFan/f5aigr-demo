const DEMO_USERNAME = "joshan";
const DEMO_PASSWORD = "F%AIP@ssw0rd";

export function isValidDemoLogin(username, password) {
  return String(username || "").trim() === DEMO_USERNAME && String(password || "") === DEMO_PASSWORD;
}
