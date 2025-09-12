import { Client, GatewayIntentBits, Message } from "discord.js";
import { Effect } from "effect";
import { Canvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import * as path from "path";
import * as fs from "fs";

// --- KCGデッキコード用定数 (deckCode.tsからコピー) ---
const CHAR_MAP =
  "AIQYgow5BJRZhpx6CKSaiqy7DLTbjrz8EMUcks19FNVdlt2!GOWemu3?HPXfnv4/";
const MAP1_EXPANSION = "eABCDEFGHI";
const MAP2_EXPANSION = "pJKLMNOPQR";

// デッキコードデコードエラー型
export type DeckCodeDecodeError =
  | { readonly type: "emptyCode"; readonly message: string }
  | {
      readonly type: "invalidCardId";
      readonly message: string;
      readonly invalidId: string;
    }
  | {
      readonly type: "cardNotFound";
      readonly message: string;
      readonly notFoundIds: readonly string[];
    }
  | {
      readonly type: "invalidFormat";
      readonly message: string;
    }
  | {
      readonly type: "unknown";
      readonly message: string;
      readonly originalError: unknown;
    };

// 型ガード関数
function isDeckCodeDecodeError(error: unknown): error is DeckCodeDecodeError {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in (error as any) &&
    "type" in (error as any)
  );
}

/**
 * KCG形式のデッキコードをデコード
 * @param deckCode KCG-から始まるデッキコード文字列
 * @returns デコードされたカードIDの配列
 * @note 無効なカードデータ（範囲外のインデックスや値）は警告なくスキップされます
 */
export const decodeKcgDeckCode = (
  deckCode: string,
): Effect.Effect<string[], DeckCodeDecodeError> => {
  return Effect.try<string[], DeckCodeDecodeError>({
    try: () => {
      // --- 1. 入力チェックと初期処理 ---
      if (!deckCode || !deckCode.startsWith("KCG-")) {
        throw {
          type: "invalidFormat",
          message: "デッキコードは'KCG-'で始まる必要があります",
        } as DeckCodeDecodeError;
      }

      const rawPayloadWithVersion = deckCode.substring(4);
      if (rawPayloadWithVersion.length === 0) {
        throw {
          type: "invalidFormat",
          message: "デッキコードのペイロードが空です",
        } as DeckCodeDecodeError;
      }

      for (const char of rawPayloadWithVersion) {
        if (CHAR_MAP.indexOf(char) === -1) {
          throw {
            type: "invalidFormat",
            message: `デッキコードに無効な文字が含まれています: ${char}`,
          } as DeckCodeDecodeError;
        }
      }

      // --- 2. パディングビット数の計算 ---
      const fifthCharOriginal = rawPayloadWithVersion[0]!;
      const indexFifthChar = CHAR_MAP.indexOf(fifthCharOriginal) + 1;

      let deckCodeFifthCharQuotient = Math.floor(indexFifthChar / 8);
      const remainderFifthChar = indexFifthChar % 8;

      let charsToRemoveFromPayloadEnd: number;
      if (remainderFifthChar === 0) {
        charsToRemoveFromPayloadEnd = 0;
      } else {
        deckCodeFifthCharQuotient++;
        charsToRemoveFromPayloadEnd = 8 - deckCodeFifthCharQuotient;
      }

      // --- 3. ペイロードを6ビットのバイナリ文字列に変換 ---
      let initialBinaryPayload = "";
      const payload = rawPayloadWithVersion.substring(1);
      for (let i = 0; i < payload.length; i++) {
        const char = payload[i]!;
        const charIndex = CHAR_MAP.indexOf(char);
        initialBinaryPayload += charIndex.toString(2).padStart(6, "0");
      }

      // --- 4. パディングを削除 ---
      let processedBinaryPayload = initialBinaryPayload;
      if (
        charsToRemoveFromPayloadEnd > 0 &&
        initialBinaryPayload.length >= charsToRemoveFromPayloadEnd
      ) {
        processedBinaryPayload = initialBinaryPayload.substring(
          0,
          initialBinaryPayload.length - charsToRemoveFromPayloadEnd,
        );
      } else if (charsToRemoveFromPayloadEnd > 0) {
        processedBinaryPayload = "";
      }

      // --- 5. バイナリを数値文字列に変換 ---
      let intermediateString = "";
      for (let i = 0; i + 10 <= processedBinaryPayload.length; i += 10) {
        const tenBitChunk = processedBinaryPayload.substring(i, i + 10);

        let signedDecimalVal: number;
        if (tenBitChunk[0]! === "1") {
          const unsignedVal = parseInt(tenBitChunk, 2);
          signedDecimalVal = unsignedVal - 1024; // 1024 = 2^10
        } else {
          signedDecimalVal = parseInt(tenBitChunk, 2);
        }

        const nVal = 500 - signedDecimalVal;

        let formattedNVal: string;
        if (nVal >= 0 && nVal < 10) {
          formattedNVal = "XX" + nVal.toString();
        } else if (nVal >= 10 && nVal < 100) {
          formattedNVal = "X" + nVal.toString();
        } else {
          formattedNVal = nVal.toString();
        }
        intermediateString += formattedNVal;
      }

      // --- 6. 数値文字列を5の倍数に調整し、'X'を'0'に置換 ---
      const remainderForFive = intermediateString.length % 5;
      let adjustedString = intermediateString;
      if (remainderForFive !== 0) {
        let charsToActuallyRemove = remainderForFive;
        let stringAsArray = intermediateString.split("");
        let removedXCount = 0;

        for (
          let i = stringAsArray.length - 1;
          i >= 0 && removedXCount < charsToActuallyRemove;
          i--
        ) {
          if (stringAsArray[i] === "X") {
            stringAsArray.splice(i, 1);
            removedXCount++;
          }
        }

        const remainingCharsToRemove = charsToActuallyRemove - removedXCount;
        if (remainingCharsToRemove > 0) {
          stringAsArray.splice(
            stringAsArray.length - remainingCharsToRemove,
            remainingCharsToRemove,
          );
        }
        adjustedString = stringAsArray.join("");
      }

      const finalNumericString = adjustedString.replace(/X/g, "0");

      // --- 7. 数値文字列をカード情報にデコード ---
      const decodedEntries: { cardIdPart: string; originalC5Value: number }[] =
        [];
      if (finalNumericString.length % 5 !== 0) {
        throw {
          type: "invalidFormat",
          message: "最終的な数値文字列の長さが5の倍数ではありません",
        } as DeckCodeDecodeError;
      }

      for (let i = 0; i < finalNumericString.length; i += 5) {
        const fiveDigitChunk = finalNumericString.substring(i, i + 5);

        const c1 = parseInt(fiveDigitChunk[0]!, 10);
        const c2 = parseInt(fiveDigitChunk[1]!, 10);
        const c3 = parseInt(fiveDigitChunk[2]!, 10);
        const c4 = parseInt(fiveDigitChunk[3]!, 10);
        const c5 = parseInt(fiveDigitChunk[4]!, 10);

        let expansionMap: string;
        if (c5 >= 1 && c5 <= 4) {
          expansionMap = MAP1_EXPANSION;
        } else if (c5 >= 6 && c5 <= 9) {
          expansionMap = MAP2_EXPANSION;
        } else {
          // 無効なC5値の場合はスキップ
          continue;
        }

        if (c1 >= expansionMap.length) {
          // 無効なC1インデックスの場合はスキップ
          continue;
        }
        const selectedCharFromMap = expansionMap[c1]!;

        let expansion: string;
        if (selectedCharFromMap === "e") {
          expansion = "ex";
        } else if (selectedCharFromMap === "p") {
          expansion = "prm";
        } else {
          expansion = selectedCharFromMap;
        }

        let type: string;
        switch (c2) {
          case 1:
            type = "A";
            break;
          case 2:
            type = "S";
            break;
          case 3:
            type = "M";
            break;
          case 4:
            type = "D";
            break;
          default:
            // 無効なC2値の場合はスキップ
            continue;
        }

        const numberPartInt = c3 * 10 + c4;
        if (numberPartInt < 1 || numberPartInt > 50) {
          // 無効な番号の場合はスキップ
          continue;
        }

        const cardIdPart = `${expansion}${type}-${numberPartInt}`;
        decodedEntries.push({ cardIdPart, originalC5Value: c5 });
      }

      // --- 8. 最終的なデッキデータ文字列を生成 ---
      const deckListOutput: string[] = [];
      for (const entry of decodedEntries) {
        const repeatCount = entry.originalC5Value % 5;
        for (let r = 0; r < repeatCount; r++) {
          deckListOutput.push(entry.cardIdPart);
        }
      }

      return deckListOutput;
    },
    catch: (error) => {
      if (isDeckCodeDecodeError(error)) {
        return error;
      }
      return {
        type: "unknown",
        message: "デッキコードのデコード中に予期しないエラーが発生しました",
        originalError: error,
      };
    },
  });
};

// --- Discordボットのロジック ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once("clientReady", () => {
  console.log("Discord Bot is Ready!");
});

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  const content = message.content;

  const slashCount = (content.match(/\//g) || []).length;
  const isKcgDeckCode = content.startsWith("KCG-");

  if (slashCount >= 20 || isKcgDeckCode) {
    console.log(`Received a relevant message: ${content}`);

    let cardIds: string[] = [];
    if (isKcgDeckCode) {
      const decodeEffect = decodeKcgDeckCode(content);
      try {
        cardIds = await Effect.runPromise(decodeEffect);
      } catch (error) {
        const decodeError = error as DeckCodeDecodeError;
        await message.reply(
          `デッキコードのデコードに失敗しました: ${decodeError.message}`,
        );
        return;
      }
    } else {
      cardIds = content.split("/");
    }

    if (cardIds.length === 0) {
      await message.reply("有効なカードIDが見つかりませんでした。");
      return;
    }

    // カードIDとその枚数をカウント
    const cardCounts = new Map<string, number>();
    for (const cardId of cardIds) {
      cardCounts.set(cardId, (cardCounts.get(cardId) || 0) + 1);
    }

    // デッキ画像の生成
    const CANVAS_WIDTH = 3840; // キャンバスの幅
    const CANVAS_PADDING_X = 241; // キャンバスのXパディング
    const CANVAS_PADDING_Y = 298; // キャンバスのYパディング
    const GRID_GAP_X = 13; // グリッドのX間隔
    const GRID_GAP_Y = 72; // グリッドのY間隔
    const TWO_ROWS_THRESHOLD = 20; // sheet2.webpを使う上限
    const THREE_ROWS_THRESHOLD = 30; // sheet.webpを使う上限

    /**
     * カード種類の数に基づいてキャンバス高さを計算
     */
    const calculateCanvasHeight = (cardCount: number): number => {
      if (cardCount <= TWO_ROWS_THRESHOLD) {
        return 1636;
      }
      return 2160;
    };

    /**
     * カード種類の数に基づいてカード幅を計算
     */
    const calculateCardWidth = (cardCount: number): number => {
      if (cardCount <= THREE_ROWS_THRESHOLD) return 324;
      return 212;
    };

    /**
     * カード種類の数に基づいてカード高さを計算
     */
    const calculateCardHeight = (cardCount: number): number => {
      if (cardCount <= THREE_ROWS_THRESHOLD) return 452;
      return 296;
    };

    /**
     * カード種類の数に基づいて行あたりのカード数を計算
     */
    const cardsPerRow = (cardCount: number): number => {
      if (cardCount <= THREE_ROWS_THRESHOLD) return 10;
      return 15;
    };

    /**
     * カード種類の数に基づいて背景画像を返す
     */
    const getBackgroundImage = (cardCount: number): string => {
      if (cardCount <= TWO_ROWS_THRESHOLD) {
        return "sheet2.webp";
      } else if (cardCount <= THREE_ROWS_THRESHOLD) {
        return "sheet.webp";
      } else {
        return "sheet_nogrid.webp";
      }
    };

    const canvas = new Canvas(
      CANVAS_WIDTH,
      calculateCanvasHeight(cardCounts.size),
    );
    const ctx = canvas.getContext("2d");

    try {
      // 背景画像の読み込みと描画
      const backgroundPath = path.join(
        process.cwd(),
        getBackgroundImage(cardCounts.size),
      );
      const backgroundImage = await loadImage(backgroundPath);
      ctx.drawImage(
        backgroundImage,
        0,
        0,
        CANVAS_WIDTH,
        calculateCanvasHeight(cardCounts.size),
      );

      let x = CANVAS_PADDING_X;
      let y = CANVAS_PADDING_Y;
      let cardsInRow = 0;
      GlobalFonts.registerFromPath(
        path.join(process.cwd(), "ShipporiMincho-Bold.ttf"),
        "ShipporiMincho",
      );

      for (const [cardId, count] of cardCounts.entries()) {
        const cardImagePath = path.join(
          process.cwd(),
          "cards",
          `${cardId}.webp`,
        );

        // カード画像が存在するかチェック
        if (!fs.existsSync(cardImagePath)) {
          console.warn(`Card image not found: ${cardImagePath}`);
          continue; // 画像がない場合はスキップ
        }

        const cardImage = await loadImage(cardImagePath);
        ctx.drawImage(
          cardImage,
          x,
          y,
          calculateCardWidth(cardCounts.size),
          calculateCardHeight(cardCounts.size),
        );

        // カード枚数の表示
        ctx.fillStyle = "black";
        ctx.font = "bold 36px ShipporiMincho";
        ctx.fillText(
          `${count}`,
          x + calculateCardWidth(cardCounts.size) * 0.46,
          y + calculateCardHeight(cardCounts.size) + 50,
        );

        x += calculateCardWidth(cardCounts.size) + GRID_GAP_X;
        cardsInRow++;

        if (cardsInRow >= cardsPerRow(cardCounts.size)) {
          x = CANVAS_PADDING_X;
          y += calculateCardHeight(cardCounts.size) + GRID_GAP_Y;
          cardsInRow = 0;
        }
      }

      const attachment = {
        attachment: canvas.toBuffer("image/jpeg"),
        name: "deck.jpg",
      };
      await message.reply({ files: [attachment] });
    } catch (error) {
      console.error("Error generating deck image:", error);
      await message.reply(
        "デッキ画像の生成中にエラーが発生しました。カードIDが正しいか確認してください。",
      );
    }
  }
});

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

if (!DISCORD_BOT_TOKEN) {
  console.error(
    "DISCORD_BOT_TOKENが設定されていません。環境変数を確認してください。",
  );
  process.exit(1);
}

client.login(DISCORD_BOT_TOKEN);
