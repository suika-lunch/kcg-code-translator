import { Client, GatewayIntentBits, Message } from "discord.js";
import { Effect, Data } from "effect";
import { Canvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import * as path from "path";
import * as fs from "fs";

// --- KCGデッキコード用定数 (deckCode.tsからコピー) ---
const CHAR_MAP =
  "AIQYgow5BJRZhpx6CKSaiqy7DLTbjrz8EMUcks19FNVdlt2!GOWemu3?HPXfnv4/";
const MAP1_EXPANSION = "eABCDEFGHI";
const MAP2_EXPANSION = "pJKLMNOPQR";

// デッキコードデコードエラー型
export class DeckCodeDecodeError extends Data.TaggedError(
  "DeckCodeDecodeError",
)<{
  readonly type:
    | "emptyCode"
    | "invalidCardId"
    | "cardNotFound"
    | "invalidFormat"
    | "unknown";
  readonly message: string;
  readonly invalidId?: string;
  readonly notFoundIds?: readonly string[];
  readonly originalError?: unknown;
}> {}

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
        throw new DeckCodeDecodeError({
          type: "invalidFormat",
          message: "デッキコードは'KCG-'で始まる必要があります",
        });
      }

      const rawPayloadWithVersion = deckCode.substring(4);
      if (rawPayloadWithVersion.length === 0) {
        throw new DeckCodeDecodeError({
          type: "invalidFormat",
          message: "デッキコードのペイロードが空です",
        });
      }

      for (const char of rawPayloadWithVersion) {
        if (CHAR_MAP.indexOf(char) === -1) {
          throw new DeckCodeDecodeError({
            type: "invalidFormat",
            message: `デッキコードに無効な文字が含まれています: ${char}`,
          });
        }
      }

      // --- 2. パディングビット数の計算と削除 ---
      const fifthCharOriginal = rawPayloadWithVersion[0]!;
      const indexFifthChar = CHAR_MAP.indexOf(fifthCharOriginal) + 1; // 1-64

      // エンコード時に追加されたパディングビット数を計算
      // indexFifthCharが8の倍数の場合、charsToRemoveFromPayloadEndは0になる
      const charsToRemoveFromPayloadEnd = (8 - (indexFifthChar % 8)) % 8;

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
      if (charsToRemoveFromPayloadEnd > 0) {
        processedBinaryPayload = initialBinaryPayload.substring(
          0,
          initialBinaryPayload.length - charsToRemoveFromPayloadEnd,
        );
      }

      // --- 5. バイナリを数値文字列に変換 ---
      let intermediateString = "";
      for (let i = 0; i + 10 <= processedBinaryPayload.length; i += 10) {
        const tenBitChunk = processedBinaryPayload.substring(i, i + 10);

        // 10ビットの符号付き整数をデコード (2の補数表現)
        let signedDecimalVal: number;
        if (tenBitChunk[0]! === "1") {
          // 負の数の場合
          const unsignedVal = parseInt(tenBitChunk, 2);
          signedDecimalVal = unsignedVal - 1024; // 1024 = 2^10
        } else {
          // 正の数の場合
          signedDecimalVal = parseInt(tenBitChunk, 2);
        }

        const nVal = 500 - signedDecimalVal; // 元の数値に戻す

        // 3桁の文字列にフォーマット。1桁、2桁の場合は'X'でパディング
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
      let finalNumericString = intermediateString;
      const remainderForFive = intermediateString.length % 5;
      if (remainderForFive !== 0) {
        // 末尾の不要な文字を切り捨てる
        finalNumericString = intermediateString.substring(
          0,
          intermediateString.length - remainderForFive,
        );
      }
      // 残った 'X' を '0' に置換 (パディング文字を数値として扱う)
      finalNumericString = finalNumericString.replace(/X/g, "0");

      // --- 7. 数値文字列をカード情報にデコード ---
      const decodedEntries: { cardIdPart: string; originalC5Value: number }[] =
        [];
      if (finalNumericString.length % 5 !== 0) {
        throw new DeckCodeDecodeError({
          type: "invalidFormat",
          message: "最終的な数値文字列の長さが5の倍数ではありません",
        });
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
      return new DeckCodeDecodeError({
        type: "unknown",
        message: "デッキコードのデコード中に予期しないエラーが発生しました",
        originalError: error,
      });
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

// デッキ画像生成に関する定数
const DECK_IMAGE_CONSTANTS = {
  CANVAS_WIDTH: 3840,
  CANVAS_PADDING_X: 241,
  CANVAS_PADDING_Y: 298,
  GRID_GAP_X: 13,
  GRID_GAP_Y: 72,
  TWO_ROWS_THRESHOLD: 20, // sheet2.webpを使う上限
  THREE_ROWS_THRESHOLD: 30, // sheet.webpを使う上限
  CANVAS_HEIGHT_TWO_ROWS: 1636, // 2行の場合のキャンバス高さ
  CANVAS_HEIGHT_THREE_ROWS: 2160, // 3行の場合のキャンバス高さ
  CARD_WIDTH_SMALL: 212, // カード種類が多い場合のカード幅
  CARD_WIDTH_LARGE: 324, // カード種類が少ない場合のカード幅
  CARD_HEIGHT_SMALL: 296, // カード種類が多い場合のカード高さ
  CARD_HEIGHT_LARGE: 452, // カード種類が少ない場合のカード高さ
  CARDS_PER_ROW_SMALL: 15, // カード種類が多い場合の1行あたりのカード数
  CARDS_PER_ROW_LARGE: 10, // カード種類が少ない場合の1行あたりのカード数
};

// パス関連の共通化ヘルパー
const getAbsolutePath = (relativePath: string) =>
  path.join(process.cwd(), relativePath);

client.once("clientReady", () => {
  console.log("Discord Bot is Ready!");
});

client.on("messageCreate", async (message: Message) => {
  if (message.author.bot) return;

  const content = message.content;

  // KCGデッキコードまたは多数のスラッシュを含むメッセージを処理
  // スラッシュが20個以上ある場合は、KCGデッキコードではないがカードIDのリストとして解釈する
  const slashCount = (content.match(/\//g) || []).length;
  const isKcgDeckCode = content.startsWith("KCG-");

  if (slashCount >= 20 || isKcgDeckCode) {
    console.log(`Received a relevant message: ${content}`);

    let cardIds: string[] = [];
    if (isKcgDeckCode) {
      const decodeEffect = decodeKcgDeckCode(content);
      try {
        cardIds = await Effect.runPromise(decodeEffect);
      } catch (error: unknown) {
        if (error instanceof DeckCodeDecodeError) {
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

    const canvas = new Canvas(
      DECK_IMAGE_CONSTANTS.CANVAS_WIDTH,
      calculateCanvasHeight(cardCounts.size),
    );
    const ctx = canvas.getContext("2d");

    try {
      // 背景画像の読み込みと描画
      const backgroundPath = getAbsolutePath(
        getBackgroundImage(cardCounts.size),
      );
      const backgroundImage = await loadImage(backgroundPath);
      ctx.drawImage(
        backgroundImage,
        0,
        0,
        DECK_IMAGE_CONSTANTS.CANVAS_WIDTH,
        calculateCanvasHeight(cardCounts.size),
      );

      let x = DECK_IMAGE_CONSTANTS.CANVAS_PADDING_X;
      let y = DECK_IMAGE_CONSTANTS.CANVAS_PADDING_Y;
      let cardsInRow = 0;
      GlobalFonts.registerFromPath(
        getAbsolutePath("ShipporiMincho-Bold.ttf"),
        "ShipporiMincho",
      );

      for (const [cardId, count] of cardCounts.entries()) {
        const cardImagePath = getAbsolutePath(
          path.join("cards", `${cardId}.webp`),
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

        x +=
          calculateCardWidth(cardCounts.size) + DECK_IMAGE_CONSTANTS.GRID_GAP_X;
        cardsInRow++;

        if (cardsInRow >= cardsPerRow(cardCounts.size)) {
          x = DECK_IMAGE_CONSTANTS.CANVAS_PADDING_X;
          y +=
            calculateCardHeight(cardCounts.size) +
            DECK_IMAGE_CONSTANTS.GRID_GAP_Y;
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

// koyeb用のWebサーバー
const port = process.env.PORT || 3000;
console.log(
  `Launching Bun HTTP server on port: ${port}, url: http://0.0.0.0:${port} 🚀`,
);
Bun.serve({
  port: port,
  fetch(_request) {
    return new Response("Hello from Koyeb");
  },
});
