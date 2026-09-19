import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import { defineConfig } from "hardhat/config";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [hardhatToolboxViem],
  paths: { sources: "./src" },
  solidity: {
    version: "0.8.28",
    path: require.resolve("solc/soljson.js"),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    testnetRehearsal: { type: "edr-simulated", chainType: "l1", chainId: 1439, mining: { auto: true, interval: 1000 } },
    default: { type: "edr-simulated", chainType: "l1" },
    localhost: { type: "http", chainType: "l1", url: "http://127.0.0.1:8545", chainId: 31337 },
  },
});
