/**
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { SuiGrpcClient } from "@mysten/sui/grpc";
import { Transaction } from "@mysten/sui/transactions";

import assert from "assert";
import dotenv from "dotenv";
import { Web3 } from "web3";

import {
  attestToMessage,
  coinTypeMatches,
  executeTransactionHelper,
  getEd25519KeypairFromPrivateKey,
} from "./helpers";
import {
  addReceiveV2,
  buildInboundBurnMessageBytes,
  loadRemoteEvmConfigFromEnv,
  loadV2ConfigFromEnv,
} from "./ptbV2";

dotenv.config();
dotenv.config({ path: "test_config.v2.env" });

const USDC_AMOUNT = BigInt(1000);

const cfg = loadV2ConfigFromEnv();
const remote = loadRemoteEvmConfigFromEnv();
const suiPrivateKey = process.env.SUI_DEPLOYER_KEY as string;
const signer = getEd25519KeypairFromPrivateKey(suiPrivateKey);

const FULLNODE_PORT = process.env.FULLNODE_PORT ?? "9001";
const SUI_RPC_URL =
  process.env.SUI_RPC_URL ?? `http://localhost:${FULLNODE_PORT}`;

const GAS_BUDGET = 1_000_000_000;

/**
 * Example: receiving/minting a USDC transfer from EVM on Sui (V2), on localnet.
 *
 * Following the Aptos V2 approach, there is no live EVM node — this script
 * synthesizes the inbound EVM message in TypeScript, signs it locally with the
 * dummy attester, and submits it through the Sui V2 receive/mint PTB
 * (receive_message -> prepare_mint -> handler::mint). On testnet/mainnet the
 * message + attestation would come from a real EVM burn + Circle's attestation
 * service instead.
 *
 * Addresses are read from .env and test_config.v2.env after `yarn deploy-local:v2`.
 */
const main = async () => {
  const client = new SuiGrpcClient({
    network: "localnet",
    baseUrl: SUI_RPC_URL,
  });
  const web3 = new Web3();

  // A unique nonce per receive (opaque 32-byte value in CCTP V2).
  const nonce =
    BigInt(Date.now()) * BigInt(1_000_000) +
    BigInt(Math.floor(Math.random() * 1_000_000));

  const message = buildInboundBurnMessageBytes(cfg, remote, {
    nonce,
    mintRecipient: signer.toSuiAddress(),
    amount: USDC_AMOUNT,
  });
  const messageHex = `0x${Buffer.from(message).toString("hex")}`;
  const attestationHex = attestToMessage(web3, messageHex);
  const attestation = Buffer.from(attestationHex.replace("0x", ""), "hex");

  const tx = new Transaction();
  addReceiveV2(tx, cfg, message, attestation);
  tx.setGasBudget(GAS_BUDGET);

  console.log("Broadcasting sui V2 receive_message tx...");
  const output = await executeTransactionHelper({
    client,
    signer,
    transaction: tx,
  });
  assert(output.effects.status.status === "success");
  console.log(`receive_message transaction successful: 0x${output.digest} \n`);

  const usdcBalanceChange = output.balanceChanges?.find((b) =>
    coinTypeMatches(b.coinType, cfg.usdcPackageId),
  );
  console.log("USDC mint on Sui (V2) successful:");
  console.log(
    `Sui recipient: ${signer.toSuiAddress()}, change: +${usdcBalanceChange?.amount}`,
  );
};

main();
