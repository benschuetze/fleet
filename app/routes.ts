import { index, layout, type RouteConfig, route } from "@react-router/dev/routes";

export default [
  layout("routes/shell.tsx", [
    index("routes/now.tsx"),
    route("repos", "routes/repos.tsx"),
    route("usage", "routes/usage.tsx"),
    route("activity", "routes/activity.tsx"),
  ]),
] satisfies RouteConfig;
