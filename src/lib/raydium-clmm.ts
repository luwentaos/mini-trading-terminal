import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SendTransactionError,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK",
);

const TICK_ARRAY_SIZE = 60;
const POOL_ACCOUNT_DISCRIMINATOR_SIZE = 8;
const TICK_ARRAY_POOL_ID_OFFSET = 8;
const TICK_ARRAY_START_INDEX_OFFSET = 40;
const SPL_MEMO_PROGRAM_ID = new PublicKey(
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
);
const SWAP_V2_DISCRIMINATOR = Buffer.from([43, 4, 237, 11, 26, 201, 30, 98]);
const DEFAULT_COMPUTE_UNIT_LIMIT = 350_000;
const DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS = 5_000;

const POOL_STATE_OFFSETS = {
  ammConfig: 1,
  tokenMint0: 65,
  tokenMint1: 97,
  tokenVault0: 129,
  tokenVault1: 161,
  observationKey: 193,
  mintDecimals0: 225,
  mintDecimals1: 226,
  tickSpacing: 227,
  liquidity: 229,
  sqrtPriceX64: 245,
  currentTick: 261,
} as const;

interface ClmmPoolState {
  ammConfig: PublicKey;
  tokenMint0: PublicKey;
  tokenMint1: PublicKey;
  tokenVault0: PublicKey;
  tokenVault1: PublicKey;
  observationKey: PublicKey;
  mintDecimals0: number;
  mintDecimals1: number;
  currentTick: number;
  sqrtPriceX64: BN;
  liquidity: BN;
  tickSpacing: number;
}

export interface GetRaydiumCLMMSwapQuote {
  inAmount: string;
  outAmount: string;
  minimumOut: string;
  priceImpactPct?: string;
}

export interface ExecuteRaydiumCLMMSuccess {
  status: "Success";
  signature: string;
  slot?: string;
  inputAmountResult?: string;
  outputAmountResult?: string;
}

export interface ExecuteRaydiumCLMMError {
  status: "Failed";
  signature?: string;
  error: string;
}

export type ExecuteRaydiumCLMMResponse =
  | ExecuteRaydiumCLMMSuccess
  | ExecuteRaydiumCLMMError;

export default class RaydiumCLMM {
  private static connection: Connection = new Connection(
    import.meta.env.VITE_HELIUS_RPC_URL,
    "confirmed",
  );

  static async getQuote(args: {
    poolAddress: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountIn: BN;
    slippageBps: number;
  }): Promise<GetRaydiumCLMMSwapQuote> {
    const { poolAddress, inputMint, outputMint, amountIn, slippageBps } = args;

    const pool = await RaydiumCLMM.fetchAndParsePoolState(poolAddress);
    const isInputToken0 = inputMint.equals(pool.tokenMint0);
    const isOutputToken0 = outputMint.equals(pool.tokenMint0);

    if (isInputToken0 === isOutputToken0) {
      throw new Error("Input and output mint are invalid for this CLMM pool");
    }

    const outAmount = RaydiumCLMM.estimateOutAmountFromSqrtPrice(
      amountIn,
      pool.sqrtPriceX64,
      pool.mintDecimals0,
      pool.mintDecimals1,
      isInputToken0,
    );

    const minimumOut = outAmount
      .mul(new BN(10000 - slippageBps))
      .div(new BN(10000));

    return {
      inAmount: amountIn.toString(),
      outAmount: outAmount.toString(),
      minimumOut: minimumOut.toString(),
    };
  }

  static async buildSwapTransaction(args: {
    payer: PublicKey;
    poolAddress: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountIn: BN;
    minimumAmountOut: BN;
    inputTokenAccount?: PublicKey;
    outputTokenAccount?: PublicKey;
  }): Promise<VersionedTransaction> {
    const {
      payer,
      poolAddress,
      inputMint,
      outputMint,
      amountIn,
      minimumAmountOut,
    } = args;
    if (amountIn.lte(new BN(0))) {
      throw new Error("amountIn must be greater than 0");
    }
    if (minimumAmountOut.lt(new BN(0))) {
      throw new Error("minimumAmountOut must not be negative");
    }

    const pool = await RaydiumCLMM.fetchAndParsePoolState(poolAddress);
    const isInputToken0 = inputMint.equals(pool.tokenMint0);
    const isOutputToken0 = outputMint.equals(pool.tokenMint0);

    if (isInputToken0 === isOutputToken0) {
      throw new Error(
        `Pool ${poolAddress.toBase58()} does not match input/output mint direction`,
      );
    }

    const [inputMintInfo, outputMintInfo] = await Promise.all([
      RaydiumCLMM.connection.getAccountInfo(inputMint),
      RaydiumCLMM.connection.getAccountInfo(outputMint),
    ]);

    if (!inputMintInfo || !outputMintInfo) {
      throw new Error("Input/output mint account not found");
    }

    const inputTokenProgram = inputMint.equals(NATIVE_MINT)
      ? TOKEN_PROGRAM_ID
      : inputMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

    const outputTokenProgram = outputMint.equals(NATIVE_MINT)
      ? TOKEN_PROGRAM_ID
      : outputMintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID;

    const inputTokenAccount =
      args.inputTokenAccount ??
      getAssociatedTokenAddressSync(
        inputMint,
        payer,
        false,
        inputTokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

    const outputTokenAccount =
      args.outputTokenAccount ??
      getAssociatedTokenAddressSync(
        outputMint,
        payer,
        false,
        outputTokenProgram,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      );

    const [inputAtaInfo, outputAtaInfo] = await Promise.all([
      RaydiumCLMM.connection.getAccountInfo(inputTokenAccount),
      RaydiumCLMM.connection.getAccountInfo(outputTokenAccount),
    ]);

    const preSwapIxs: TransactionInstruction[] = [];
    if (!inputAtaInfo) {
      preSwapIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          inputTokenAccount,
          payer,
          inputMint,
          inputTokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }

    if (!outputAtaInfo) {
      preSwapIxs.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          outputTokenAccount,
          payer,
          outputMint,
          outputTokenProgram,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
      );
    }

    if (inputMint.equals(NATIVE_MINT)) {
      const lamports = RaydiumCLMM.bnToSafeNumber(amountIn, "amountIn");
      preSwapIxs.push(
        SystemProgram.transfer({
          fromPubkey: payer,
          toPubkey: inputTokenAccount,
          lamports,
        }),
      );
      preSwapIxs.push(createSyncNativeInstruction(inputTokenAccount));
    }

    const inputVault = isInputToken0 ? pool.tokenVault0 : pool.tokenVault1;
    const outputVault = isInputToken0 ? pool.tokenVault1 : pool.tokenVault0;

    const tickArrays = await RaydiumCLMM.getSwapTickArrays(
      poolAddress,
      pool.currentTick,
      pool.tickSpacing,
      isInputToken0,
    );

    if (tickArrays.length === 0) {
      throw new Error("No usable tick arrays found for swap");
    }

    // Raydium SwapV2 expects ex-bitmap + tick arrays as trailing remaining accounts.
    const remainingAccounts = [
      {
        pubkey: RaydiumCLMM.getTickArrayBitmapExtension(poolAddress),
        isSigner: false,
        isWritable: true,
      },
      ...tickArrays.map((pubkey) => ({
        pubkey,
        isSigner: false,
        isWritable: true,
      })),
    ];

    const swapIx = new TransactionInstruction({
      programId: RAYDIUM_CLMM_PROGRAM_ID,
      keys: [
        { pubkey: payer, isSigner: true, isWritable: false },
        { pubkey: pool.ammConfig, isSigner: false, isWritable: false },
        { pubkey: poolAddress, isSigner: false, isWritable: true },
        { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
        { pubkey: inputVault, isSigner: false, isWritable: true },
        { pubkey: outputVault, isSigner: false, isWritable: true },
        { pubkey: pool.observationKey, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SPL_MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: inputMint, isSigner: false, isWritable: false },
        { pubkey: outputMint, isSigner: false, isWritable: false },
        ...remainingAccounts,
      ],
      data: RaydiumCLMM.buildSwapV2BaseInData(amountIn, minimumAmountOut),
    });

    const postSwapIxs: TransactionInstruction[] = [];
    if (outputMint.equals(NATIVE_MINT) && !args.outputTokenAccount) {
      postSwapIxs.push(
        createCloseAccountInstruction(
          outputTokenAccount,
          payer,
          payer,
          [],
          TOKEN_PROGRAM_ID,
        ),
      );
    }

    const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
      units: RaydiumCLMM.getComputeUnitLimit(),
    });

    const priorityIx = ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: RaydiumCLMM.getComputeUnitPriceMicroLamports(),
    });

    const { blockhash } = await RaydiumCLMM.connection.getLatestBlockhash();

    const message = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: blockhash,
      instructions: [
        computeIx,
        priorityIx,
        ...preSwapIxs,
        swapIx,
        ...postSwapIxs,
      ],
    }).compileToV0Message();

    return new VersionedTransaction(message);
  }

  static async executeSwap(args: {
    payer: PublicKey;
    signTransaction: (
      tx: VersionedTransaction,
    ) => Promise<VersionedTransaction>;
    poolAddress: PublicKey;
    inputMint: PublicKey;
    outputMint: PublicKey;
    amountIn: BN;
    minimumAmountOut: BN;
    inputTokenAccount?: PublicKey;
    outputTokenAccount?: PublicKey;
  }): Promise<ExecuteRaydiumCLMMResponse> {
    try {
      const { signTransaction, ...buildArgs } = args;
      const tx = await RaydiumCLMM.buildSwapTransaction(buildArgs);
      const signedTx = await signTransaction(tx);

      const { blockhash, lastValidBlockHeight } =
        await RaydiumCLMM.connection.getLatestBlockhash();

      const signature = await RaydiumCLMM.connection.sendTransaction(signedTx, {
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3,
      });

      await RaydiumCLMM.connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight },
        "confirmed",
      );

      return { status: "Success", signature };
    } catch (err: unknown) {
      let msg = err instanceof Error ? err.message : String(err);
      if (err instanceof SendTransactionError) {
        try {
          const logs = await err.getLogs(RaydiumCLMM.connection);
          if (logs && logs.length > 0) {
            msg = `${msg}\n${logs.join("\n")}`;
          }
        } catch {
          // ignore nested log fetch errors
        }
      }
      return { status: "Failed", error: msg };
    }
  }

  private static buildSwapV2BaseInData(
    amountIn: BN,
    minimumAmountOut: BN,
  ): Buffer {
    return Buffer.concat([
      SWAP_V2_DISCRIMINATOR,
      RaydiumCLMM.u64ToBuffer(amountIn),
      RaydiumCLMM.u64ToBuffer(minimumAmountOut),
      RaydiumCLMM.u128ToBuffer(new BN(0)),
      Buffer.from([1]), // is_base_input = true
    ]);
  }

  private static async fetchAndParsePoolState(
    poolAddress: PublicKey,
  ): Promise<ClmmPoolState> {
    const accountInfo = await RaydiumCLMM.connection.getAccountInfo(poolAddress);
    if (!accountInfo?.data) {
      throw new Error(`Pool not found: ${poolAddress.toBase58()}`);
    }

    const data = Buffer.from(accountInfo.data).subarray(
      POOL_ACCOUNT_DISCRIMINATOR_SIZE,
    );
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

    const readPubkey = (offset: number): PublicKey =>
      new PublicKey(data.subarray(offset, offset + 32));

    return {
      ammConfig: readPubkey(POOL_STATE_OFFSETS.ammConfig),
      tokenMint0: readPubkey(POOL_STATE_OFFSETS.tokenMint0),
      tokenMint1: readPubkey(POOL_STATE_OFFSETS.tokenMint1),
      tokenVault0: readPubkey(POOL_STATE_OFFSETS.tokenVault0),
      tokenVault1: readPubkey(POOL_STATE_OFFSETS.tokenVault1),
      observationKey: readPubkey(POOL_STATE_OFFSETS.observationKey),
      mintDecimals0: view.getUint8(POOL_STATE_OFFSETS.mintDecimals0),
      mintDecimals1: view.getUint8(POOL_STATE_OFFSETS.mintDecimals1),
      tickSpacing: view.getUint16(POOL_STATE_OFFSETS.tickSpacing, true),
      liquidity: RaydiumCLMM.readU128LE(view, POOL_STATE_OFFSETS.liquidity),
      sqrtPriceX64: RaydiumCLMM.readU128LE(view, POOL_STATE_OFFSETS.sqrtPriceX64),
      currentTick: view.getInt32(POOL_STATE_OFFSETS.currentTick, true),
    };
  }

  private static async getSwapTickArrays(
    poolAddress: PublicKey,
    currentTick: number,
    tickSpacing: number,
    zeroForOne: boolean,
  ): Promise<PublicKey[]> {
    const currentStart = RaydiumCLMM.getTickArrayStartIndexByTick(
      currentTick,
      tickSpacing,
    );

    const rawTickArrays = await RaydiumCLMM.connection.getProgramAccounts(
      RAYDIUM_CLMM_PROGRAM_ID,
      {
        commitment: "confirmed",
        // We only need startTickIndex to sort arrays; slice keeps RPC payload small.
        dataSlice: {
          offset: TICK_ARRAY_START_INDEX_OFFSET,
          length: 4,
        },
        filters: [
          {
            memcmp: {
              offset: TICK_ARRAY_POOL_ID_OFFSET,
              bytes: poolAddress.toBase58(),
            },
          },
        ],
      },
    );

    if (rawTickArrays.length === 0) {
      throw new Error(`No tick array account found for pool ${poolAddress.toBase58()}`);
    }

    const arrays = rawTickArrays
      .filter((entry) => entry.account.data.length >= 4)
      .map((entry) => ({
        pubkey: entry.pubkey,
        start: entry.account.data.readInt32LE(0),
      }));

    if (arrays.length === 0) {
      throw new Error(`No decodable tick array account found for pool ${poolAddress.toBase58()}`);
    }

    const currentArray = arrays.find((a) => a.start === currentStart);
    const first =
      currentArray ??
      arrays
        .slice()
        .sort((a, b) => Math.abs(a.start - currentStart) - Math.abs(b.start - currentStart))[0];

    const sameOrForward = arrays.filter((a) =>
      zeroForOne ? a.start <= first.start : a.start >= first.start,
    );
    const backward = arrays.filter((a) =>
      zeroForOne ? a.start > first.start : a.start < first.start,
    );

    sameOrForward.sort((a, b) => (zeroForOne ? b.start - a.start : a.start - b.start));
    backward.sort((a, b) => (zeroForOne ? b.start - a.start : a.start - b.start));

    const ordered = [...sameOrForward, ...backward]
      .filter((a, idx, list) => idx === list.findIndex((x) => x.pubkey.equals(a.pubkey)))
      .slice(0, 3)
      .map((a) => a.pubkey);

    return ordered;
  }

  private static getTickArrayStartIndexByTick(
    tickIndex: number,
    tickSpacing: number,
  ): number {
    const ticksInArray = TICK_ARRAY_SIZE * tickSpacing;
    let arrayIndex = tickIndex / ticksInArray;
    if (tickIndex < 0 && tickIndex % ticksInArray !== 0) {
      arrayIndex = Math.ceil(arrayIndex) - 1;
    } else {
      arrayIndex = Math.floor(arrayIndex);
    }
    return arrayIndex * ticksInArray;
  }

  private static getTickArrayBitmapExtension(poolAddress: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("pool_tick_array_bitmap_extension"), poolAddress.toBuffer()],
      RAYDIUM_CLMM_PROGRAM_ID,
    )[0];
  }

  private static readU128LE(view: DataView, offset: number): BN {
    const lo = view.getBigUint64(offset, true);
    const hi = view.getBigUint64(offset + 8, true);
    return new BN((hi * 2n ** 64n + lo).toString());
  }

  private static u64ToBuffer(value: BN): Buffer {
    const b = BigInt(value.toString());
    const out = Buffer.alloc(8);
    out.writeBigUInt64LE(b, 0);
    return out;
  }

  private static u128ToBuffer(value: BN): Buffer {
    const b = BigInt(value.toString());
    const out = Buffer.alloc(16);
    out.writeBigUInt64LE(b & ((1n << 64n) - 1n), 0);
    out.writeBigUInt64LE(b >> 64n, 8);
    return out;
  }

  private static bnToSafeNumber(value: BN, fieldName: string): number {
    const n = Number(value.toString());
    if (!Number.isSafeInteger(n) || n < 0) {
      throw new Error(`${fieldName} exceeds JS safe integer range`);
    }
    return n;
  }

  private static getComputeUnitLimit(): number {
    const raw = import.meta.env.VITE_SOLANA_COMPUTE_UNIT_LIMIT;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0) return n;
    return DEFAULT_COMPUTE_UNIT_LIMIT;
  }

  private static getComputeUnitPriceMicroLamports(): number {
    const raw = import.meta.env.VITE_SOLANA_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n >= 0) return n;
    return DEFAULT_COMPUTE_UNIT_PRICE_MICROLAMPORTS;
  }

  private static estimateOutAmountFromSqrtPrice(
    amountIn: BN,
    sqrtPriceX64: BN,
    _decimals0: number,
    _decimals1: number,
    inputIsToken0: boolean,
  ): BN {
    const sqrt = Number(sqrtPriceX64.toString());
    if (!Number.isFinite(sqrt) || sqrt <= 0) {
      return amountIn;
    }

    // Raydium CLMM sqrtPriceX64 can be treated as raw token1/token0 ratio in Q64.
    const rawPriceToken1PerToken0 = (sqrt / 2 ** 64) * (sqrt / 2 ** 64);

    if (
      !Number.isFinite(rawPriceToken1PerToken0) ||
      rawPriceToken1PerToken0 <= 0
    ) {
      return amountIn;
    }

    const inRaw = Number(amountIn.toString());
    if (!Number.isFinite(inRaw) || inRaw <= 0) {
      return new BN(0);
    }

    const outRaw = inputIsToken0
      ? inRaw * rawPriceToken1PerToken0
      : inRaw / rawPriceToken1PerToken0;

    if (!Number.isFinite(outRaw) || outRaw <= 0) {
      return new BN(1);
    }

    return new BN(Math.floor(outRaw).toString());
  }
}
