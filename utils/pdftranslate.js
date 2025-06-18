import vision from "@google-cloud/vision";
import { TranslationServiceClient } from "@google-cloud/translate";

const visionClient = new vision.ImageAnnotatorClient();
const translate    = new TranslationServiceClient();
const PARENT = `projects/${process.env.GOOGLE_PROJECT_ID}/locations/global`;

export async function translatePdf(buffer, target = "en") {
  const [op] = await visionClient.asyncBatchAnnotateFiles({
    requests: [{
      inputConfig: { content: buffer, mimeType: "application/pdf" },
      features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
      outputConfig: { gcsDestination: { uri: `gs://whatsapp-ocr-tmp/${Date.now()}/` } }
    }]
  });
  const [{ responses }] = await op.promise();
  const ocrText = responses.flatMap(r => r.responses || [])
                            .map(r => r.fullTextAnnotation?.text || "")
                            .join("\n");

  const [resp] = await translate.translateText({
    parent: PARENT,
    contents: [ocrText],
    mimeType: "text/plain",
    sourceLanguageCode: "es",
    targetLanguageCode: target,
  });
  return resp.translations[0].translatedText;
}
