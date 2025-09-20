import { Client, GatewayIntentBits, Message } from "discord.js";
import { Canvas, loadImage, GlobalFonts, Image } from "@napi-rs/canvas";
import * as path from "path";

// --- KCGデッキコード用定数 (deckCode.tsからコピー) ---
const CHAR_MAP =
  "AIQYgow5BJRZhpx6CKSaiqy7DLTbjrz8EMUcks19FNVdlt2!GOWemu3?HPXfnv4/";
const MAP1_EXPANSION = "eABCDEFGHI";
const MAP2_EXPANSION = "pJKLMNOPQR";
const VALID_CARD_ID_RE = /^(?:ex|prm|[A-R])[ASMD]-(?:[1-9]|[1-4][0-9]|50)$/;

// 画像ロードを簡易キャッシュ
const imageCache = new Map<string, Image>();
const pendingLoads = new Map<string, Promise<Image>>();
const MAX_IMAGE_CACHE = 128;
async function loadCardImage(cardId: string) {
  const abs = getAbsolutePath(path.join("cards", `${cardId}.webp`));
  const cached = imageCache.get(abs);
  if (cached) return cached;

  const inflight = pendingLoads.get(abs);
  if (inflight) return await inflight;

  const p = (async () => {
    try {
      const img = await loadImage(abs);
      imageCache.set(abs, img);
      if (imageCache.size > MAX_IMAGE_CACHE) {
        const oldestKey = imageCache.keys().next().value;
        if (oldestKey) imageCache.delete(oldestKey);
      }
      return img;
    } catch {
      const phPath = getAbsolutePath("placeholder.webp");
      const phCached = imageCache.get(phPath);
      if (phCached) {
        imageCache.set(abs, phCached);
        return phCached;
      }
      try {
        const ph = await loadImage(phPath);
        imageCache.set(phPath, ph);
        imageCache.set(abs, ph);
        return ph;
      } catch (e) {
        console.error("Failed to load placeholder.webp", e);
        throw e;
      }
    } finally {
      pendingLoads.delete(abs);
    }
  })();
  pendingLoads.set(abs, p);
  return await p;
}

/**
 * KCG形式のデッキコードをデコード
 * @param deckCode KCG-から始まるデッキコード文字列
 * @returns デコードされたカードIDの配列
 * @note 無効なカードデータ（範囲外のインデックスや値）は警告なくスキップされます
 */
export const decodeKcgDeckCode = (deckCode: string): string[] => {
  // --- 1. 入力チェックと初期処理 ---
  if (!deckCode || !deckCode.startsWith("KCG-")) {
    throw new Error("デッキコードは'KCG-'で始まる必要があります");
  }

  const rawPayloadWithVersion = deckCode.substring(4);
  if (rawPayloadWithVersion.length === 0) {
    throw new Error("デッキコードのペイロードが空です");
  }

  for (const char of rawPayloadWithVersion) {
    if (CHAR_MAP.indexOf(char) === -1) {
      throw new Error(`デッキコードに無効な文字が含まれています: ${char}`);
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
  const decodedEntries: { cardIdPart: string; originalC5Value: number }[] = [];
  if (finalNumericString.length % 5 !== 0) {
    throw new Error("最終的な数値文字列の長さが5の倍数ではありません");
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
};

// --- Discordボットのロジック ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// デッキ画像生成に関する定数
const DECK_IMAGE_CONSTANTS = {
  CANVAS_WIDTH: 3840,
  CANVAS_PADDING_X: 241,
  CANVAS_PADDING_Y: 298,
  GRID_GAP_X: 13,
  GRID_GAP_Y: 72,
  TWO_ROWS_THRESHOLD: 20, // sheet2.webpを使うカード種類上限
  THREE_ROWS_THRESHOLD: 30, // sheet.webpを使うカード種類上限
  CANVAS_HEIGHT_TWO_ROWS: 1636, // 2行の場合のキャンバス高さ
  CANVAS_HEIGHT_THREE_ROWS: 2160, // 3行の場合のキャンバス高さ
  CARD_WIDTH_SMALL: 212, // 30種を超える場合のカード幅
  CARD_WIDTH_LARGE: 324, // 30種を超えない場合のカード幅
  CARD_HEIGHT_SMALL: 296, // 30種を超える場合のカード高さ
  CARD_HEIGHT_LARGE: 452, // 30種を超えない場合のカード高さ
  CARDS_PER_ROW_SMALL: 15, // 30種を超える場合の1行あたりのカード数
  CARDS_PER_ROW_LARGE: 10, // 30種を超えない場合の1行あたりのカード数
};

// パス関連の共通化ヘルパー
const getAbsolutePath = (relativePath: string) =>
  path.join(process.cwd(), relativePath);

client.once("clientReady", () => {
  GlobalFonts.registerFromPath(
    getAbsolutePath("ShipporiMincho-Bold.ttf"),
    "ShipporiMincho",
  );
  console.log("Discord Bot is Ready!");
});

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  const content = message.content;

  // KCGデッキコードまたは多数のスラッシュを含むメッセージを処理
  // スラッシュが50個以上ある場合は、KCGデッキコードではないがカードIDのリストとして解釈する
  const slashCount = (content.match(/\//g) || []).length;
  const isKcgDeckCode = content.startsWith("KCG-");

  if (slashCount >= 50 || isKcgDeckCode) {
    console.log(`Received a relevant message: ${content}`);

    let cardIds: string[] = [];
    if (isKcgDeckCode) {
      try {
        cardIds = decodeKcgDeckCode(content);
      } catch (error: unknown) {
        if (error instanceof Error) {
          await message.reply(
            `デッキコードのデコードに失敗しました: ${error.message}`,
          );
        } else {
          await message.reply(`予期せぬエラーが発生しました: ${String(error)}`);
        }
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

    /**
     * カード種類の数に基づいてキャンバス高さを計算
     */
    const calculateCanvasHeight = (cardCount: number): number => {
      if (cardCount <= DECK_IMAGE_CONSTANTS.TWO_ROWS_THRESHOLD) {
        return DECK_IMAGE_CONSTANTS.CANVAS_HEIGHT_TWO_ROWS;
      }
      return DECK_IMAGE_CONSTANTS.CANVAS_HEIGHT_THREE_ROWS;
    };

    /**
     * カード種類の数に基づいてカード幅を計算
     */
    const calculateCardWidth = (cardCount: number): number => {
      if (cardCount <= DECK_IMAGE_CONSTANTS.THREE_ROWS_THRESHOLD)
        return DECK_IMAGE_CONSTANTS.CARD_WIDTH_LARGE;
      return DECK_IMAGE_CONSTANTS.CARD_WIDTH_SMALL;
    };

    /**
     * カード種類の数に基づいてカード高さを計算
     */
    const calculateCardHeight = (cardCount: number): number => {
      if (cardCount <= DECK_IMAGE_CONSTANTS.THREE_ROWS_THRESHOLD)
        return DECK_IMAGE_CONSTANTS.CARD_HEIGHT_LARGE;
      return DECK_IMAGE_CONSTANTS.CARD_HEIGHT_SMALL;
    };

    /**
     * カード種類の数に基づいて行あたりのカード数を計算
     */
    const cardsPerRow = (cardCount: number): number => {
      if (cardCount <= DECK_IMAGE_CONSTANTS.THREE_ROWS_THRESHOLD)
        return DECK_IMAGE_CONSTANTS.CARDS_PER_ROW_LARGE;
      return DECK_IMAGE_CONSTANTS.CARDS_PER_ROW_SMALL;
    };

    /**
     * カード種類の数に基づいて背景画像を返す
     */
    const getBackgroundImage = (cardCount: number): string => {
      if (cardCount <= DECK_IMAGE_CONSTANTS.TWO_ROWS_THRESHOLD) {
        return "sheet2.webp";
      } else if (cardCount <= DECK_IMAGE_CONSTANTS.THREE_ROWS_THRESHOLD) {
        return "sheet.webp";
      } else {
        return "sheet_nogrid.webp";
      }
    };

    // 妥当なカードIDのみを対象化
    const validEntries = Array.from(cardCounts.entries()).filter(([cardId]) =>
      VALID_CARD_ID_RE.test(cardId),
    );
    const distinctValidCount = validEntries.length;
    if (distinctValidCount === 0) {
      await message.reply("有効なカードIDが見つかりませんでした。");
      return;
    }

    const canvasHeight = calculateCanvasHeight(distinctValidCount);
    const canvas = new Canvas(DECK_IMAGE_CONSTANTS.CANVAS_WIDTH, canvasHeight);
    const ctx = canvas.getContext("2d");

    try {
      // 背景画像の読み込みと描画
      const backgroundPath = getAbsolutePath(
        getBackgroundImage(distinctValidCount),
      );
      const backgroundImage = await loadImage(backgroundPath);
      ctx.drawImage(
        backgroundImage,
        0,
        0,
        DECK_IMAGE_CONSTANTS.CANVAS_WIDTH,
        canvasHeight,
      );

      ctx.textAlign = "center"; // テキストを中央揃え
      ctx.fillStyle = "#353100"; // 文字色を調整

      // 合計枚数の集計
      const totalCardCount = validEntries.reduce(
        (sum, [, count]) => sum + count,
        0,
      );

      // 合計枚数テキストの描画
      ctx.font = "bold 128px ShipporiMincho";
      const totalCountText = `合計枚数: ${totalCardCount}枚`;

      ctx.fillText(totalCountText, canvas.width / 2, 240);

      // 各カードの画像と枚数の描画
      const cardW = calculateCardWidth(distinctValidCount);
      const cardH = calculateCardHeight(distinctValidCount);
      const perRow = cardsPerRow(distinctValidCount);
      let x = DECK_IMAGE_CONSTANTS.CANVAS_PADDING_X;
      let y = DECK_IMAGE_CONSTANTS.CANVAS_PADDING_Y;
      let cardsInRow = 0;
      ctx.font = "bold 36px ShipporiMincho";

      const entriesWithImages = await Promise.all(
        validEntries.map(async ([cardId, count]) => ({
          count,
          img: await loadCardImage(cardId),
        })),
      );
      for (const { img, count } of entriesWithImages) {
        ctx.drawImage(img, x, y, cardW, cardH);
        ctx.fillText(`${count}`, x + cardW / 2, y + cardH + 50);
        x += cardW + DECK_IMAGE_CONSTANTS.GRID_GAP_X;
        cardsInRow++;
        if (cardsInRow >= perRow) {
          x = DECK_IMAGE_CONSTANTS.CANVAS_PADDING_X;
          y += cardH + DECK_IMAGE_CONSTANTS.GRID_GAP_Y;
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

  // 隠し画像をリプライ
  const clodsireCount = (content.match(/ン/g) || []).length;
  if (clodsireCount >= 10) {
    try {
      await message.reply({ files: [getAbsolutePath("secret.webp")] });
    } catch (error) {
      console.error("Error replying with secret.webp:", error);
    }
  }
});

const DISCORD_BOT_TOKEN = process.env["DISCORD_BOT_TOKEN"];

if (!DISCORD_BOT_TOKEN) {
  console.error(
    "DISCORD_BOT_TOKENが設定されていません。環境変数を確認してください。",
  );
  process.exit(1);
}

client.login(DISCORD_BOT_TOKEN);

// koyeb用のWebサーバー
const port = process.env["PORT"] || 3000;
console.log(
  `Launching Bun HTTP server on port: ${port}, url: http://0.0.0.0:${port} 🚀`,
);
Bun.serve({
  port: port,
  fetch(_request) {
    return new Response("Hello from Koyeb");
  },
});
