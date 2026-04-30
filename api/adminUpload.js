const ADMIN_UPLOAD_URL = "https://너의-vercel-도메인.vercel.app/api/adminUpload";
const ADMIN_SECRET = "너만아는_긴_비밀키";
const CHUNK_SIZE = 1000;

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🚀 Firebase 관리')
    .addItem('데이터 전체 전송 (Active 방식)', 'uploadToFirebaseMaster')
    .addToUi();
}

function uploadToFirebaseMaster() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  let totalData = {};
  let duplicateBarcodes = [];

  sheets.forEach(sheet => {
    const lastRow = sheet.getLastRow();
    if (lastRow < 4) return;

    const headers = sheet.getRange(3, 1, 1, sheet.getLastColumn()).getValues()[0];
    const dataRange = sheet.getRange(4, 1, lastRow - 3, sheet.getLastColumn()).getValues();

    dataRange.forEach(row => {
      let barcode = "";
      let productObj = { common: {} };

      headers.forEach((header, index) => {
        let value = row[index];
        if (!header || value === "" || value === undefined) return;

        let h = String(header).trim().toLowerCase()
          .replace(/[\.\#\$\/\[\]]/g, "_")
          .replace(/\s+/g, "");

        const val = String(value).trim();

        if (h === "barcode") {
          barcode = val.replace(/[\.\#\$\/\[\]]/g, "");
        } else if (h.includes("_")) {
          let [field, lang] = h.split("_");
          if (lang === "jp") lang = "ja";
          if (!productObj[lang]) productObj[lang] = {};
          productObj[lang][field] = val;
        } else {
          productObj.common[h] = val;
        }
      });

      if (barcode) {
        if (totalData[barcode]) duplicateBarcodes.push(barcode);
        totalData[barcode] = productObj;
      }
    });
  });

  const barcodes = Object.keys(totalData);
  const totalCount = barcodes.length;

  if (totalCount === 0) {
    SpreadsheetApp.getUi().alert("❌ 전송할 상품 데이터가 없습니다.");
    return;
  }

  if (duplicateBarcodes.length > 0) {
    SpreadsheetApp.getUi().alert(
      "❌ 중복 바코드가 있어 업로드를 중단합니다.\n\n" +
      duplicateBarcodes.slice(0, 30).join("\n") +
      "\n\n총 중복 수: " + duplicateBarcodes.length + "개"
    );
    return;
  }

  const confirm = SpreadsheetApp.getUi().alert(
    "Active 방식으로 Firebase를 업데이트합니다.\n\n" +
    "총 상품 수: " + totalCount + "개\n" +
    "분할 단위: " + CHUNK_SIZE + "개\n\n" +
    "계속할까요?",
    SpreadsheetApp.getUi().ButtonSet.YES_NO
  );

  if (confirm !== SpreadsheetApp.getUi().Button.YES) return;

  const startResult = callAdminApi({
    action: "start",
    totalCount: totalCount
  });

  if (!startResult.ok) {
    SpreadsheetApp.getUi().alert(
      "❌ 업로드 준비 실패\n\n" +
      "에러 코드: " + startResult.code + "\n" +
      "내용: " + startResult.text
    );
    return;
  }

  const parsedStart = JSON.parse(startResult.text);
  const targetVersion = parsedStart.targetVersion;

  let successCount = 0;

  for (let i = 0; i < barcodes.length; i += CHUNK_SIZE) {
    const chunkBarcodes = barcodes.slice(i, i + CHUNK_SIZE);
    let chunkData = {};

    chunkBarcodes.forEach(barcode => {
      chunkData[barcode] = totalData[barcode];
    });

    const uploadResult = callAdminApi({
      action: "upload",
      targetVersion: targetVersion,
      products: chunkData
    });

    if (!uploadResult.ok) {
      SpreadsheetApp.getUi().alert(
        "❌ 업로드 중단\n\n" +
        "구간: " + (i + 1) + " ~ " + Math.min(i + CHUNK_SIZE, totalCount) + "\n" +
        "에러 코드: " + uploadResult.code + "\n" +
        "내용: " + uploadResult.text + "\n\n" +
        "기존 서비스 DB는 그대로 유지됩니다."
      );
      return;
    }

    successCount += chunkBarcodes.length;
  }

  const finishResult = callAdminApi({
    action: "finish",
    targetVersion: targetVersion,
    totalCount: totalCount
  });

  if (!finishResult.ok) {
    SpreadsheetApp.getUi().alert(
      "❌ 최종 전환 실패\n\n" +
      "에러 코드: " + finishResult.code + "\n" +
      "내용: " + finishResult.text + "\n\n" +
      "기존 서비스 DB는 그대로 유지됩니다."
    );
    return;
  }

  SpreadsheetApp.getUi().alert(
    "✅ Firebase Active 방식 업데이트 성공!\n\n" +
    "총 상품 수: " + totalCount + "개\n" +
    "전송 완료: " + successCount + "개\n" +
    "활성 DB: products_" + targetVersion
  );
}

function callAdminApi(payload) {
  const options = {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + ADMIN_SECRET
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(ADMIN_UPLOAD_URL, options);
    return {
      ok: response.getResponseCode() === 200,
      code: response.getResponseCode(),
      text: response.getContentText()
    };
  } catch (e) {
    return {
      ok: false,
      code: "NETWORK_ERROR",
      text: e.toString()
    };
  }
}
