import html from "./app.html";

export const APP_HTML: string = html;

export const MANIFEST = JSON.stringify({
  name: "Day book",
  short_name: "Day book",
  start_url: "/app#today",
  scope: "/app",
  display: "standalone",
  background_color: "#F6F5F2",
  theme_color: "#F6F5F2"
});
