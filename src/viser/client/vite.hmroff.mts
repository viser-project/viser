import base from "./vite.config.mts";
export default async (env) => {
  const resolved = typeof base === "function" ? await base(env) : base;
  return { ...resolved, server: { ...(resolved.server || {}), hmr: false, watch: { ignored: ["**/.nodeenv/**", "**/node_modules/**"] } } };
};
