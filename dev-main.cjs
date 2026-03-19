require("tsconfig-paths/register");
require("esbuild-register/dist/node").register({
  target: "node22",
  format: "cjs"
});

require("./src/main/main.ts");
