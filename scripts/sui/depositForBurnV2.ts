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
  eventBytes,
  executeTransactionWithRetry,
  getEd25519KeypairFromPrivateKey,
  splitCoinForAmount,
} from "./helpers";
import { addDepositForBurnV2, loadV2ConfigFromEnv } from "./ptbV2";
import { REMOTE_EVM_DOMAIN } from "./constants";

dotenv.config();
dotenv.config({ path: "test_config.v2.env" });

const USDC_AMOUNT = 1;
const DESTINATION_DOMAIN = REMOTE_EVM_DOMAIN;
const MAX_FEE = BigInt(0);
const MIN_FINALITY_THRESHOLD = 2000;
const evmUserAddress = "0xfabb0ac9d68b0b445fb7357272ff202c5651694a";

const cfg = loadV2ConfigFromEnv();
const suiPrivateKey = process.env.SUI_DEPLOYER_KEY as string;
const signer = getEd25519KeypairFromPrivateKey(suiPrivateKey);

const FULLNODE_PORT = process.env.FULLNODE_PORT ?? "9001";
const SUI_RPC_URL =
  process.env.SUI_RPC_URL ?? `http://localhost:${FULLNODE_PORT}`;

/**
 * Example: burning USDC on Sui (V2) to bridge to EVM, on localnet.
 *
 * Following the Aptos V2 approach, the V2 E2E does not run a live EVM node — the
 * counterpart EVM message is validated by serializing it in TypeScript. This
 * script performs the real Sui-side V2 burn (the two-call hot-potato PTB) and
 * prints the emitted message + its local attestation. On testnet/mainnet the
 * attestation would come from Circle's attestation service instead.
 *
 * Addresses are read from .env and test_config.v2.env after `yarn deploy-local:v2`.
 */
const main = async () => {
  const client = new SuiGrpcClient({
    network: "localnet",
    baseUrl: SUI_RPC_URL,
  });
  // web3 is only used for keccak256 over the message bytes (no network calls).
  const web3 = new Web3();

  // The coin selection and the tx build both live inside `buildTransaction` so
  // that a retry re-reads them: splitting from an owned USDC coin advances its
  // version, and a stale ref is rejected at submit time.
  console.log("Broadcasting sui V2 deposit_for_burn tx...");
  const output = await executeTransactionWithRetry({
    client,
    signer,
    buildTransaction: async () => {
      const tx = new Transaction();

      // Merge the owner's USDC coins and split off the burn amount.
      const coin = await splitCoinForAmount({
        tx,
        client,
        owner: signer.toSuiAddress(),
        coinType: `${cfg.usdcPackageId}::usdc::USDC`,
        amount: USDC_AMOUNT,
      });

      addDepositForBurnV2(tx, cfg, coin, {
        destinationDomain: DESTINATION_DOMAIN,
        mintRecipient: evmUserAddress,
        maxFee: MAX_FEE,
        minFinalityThreshold: MIN_FINALITY_THRESHOLD,
      });

      return tx;
    },
  });
  assert(output.effects.status.status === "success");
  console.log(`deposit_for_burn transaction successful: 0x${output.digest} \n`);

  const messageRaw = eventBytes(
    (
      output.events?.find((event) =>
        event.type.includes("send_message::MessageSent"),
      )?.parsedJson as { message: unknown }
    ).message,
  );
  const messageHex = `0x${Buffer.from(messageRaw).toString("hex")}`;
  const attestation = attestToMessage(web3, messageHex);

  console.log("USDC burn on Sui (V2) successful:");
  console.log(`Emitted message: ${messageHex}`);
  console.log(`Local attestation: ${attestation}`);
};

main();
