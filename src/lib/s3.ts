import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createLogger } from "@/lib/logger";

const log = createLogger("lib/s3");

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const region = process.env.AWS_REGION || "ap-south-1";
export const S3_BUCKET_NAME = process.env.AWS_S3_BUCKET_NAME || "trovenapp";

export const isS3Configured = Boolean(accessKeyId && secretAccessKey);

export const s3Client = isS3Configured
  ? new S3Client({
      region,
      credentials: {
        accessKeyId: accessKeyId!,
        secretAccessKey: secretAccessKey!,
      },
    })
  : null;

export async function uploadToS3(params: {
  key: string;
  body: Buffer;
  contentType: string;
  bucket?: string;
}): Promise<{ url: string; path: string; bucket: string }> {
  if (!s3Client) {
    throw new Error("AWS S3 credentials not configured");
  }

  const bucket = params.bucket || S3_BUCKET_NAME;

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: params.key,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );

  const publicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${params.key}`;
  log.info(`Uploaded to S3: ${publicUrl}`);

  return {
    url: publicUrl,
    path: params.key,
    bucket,
  };
}

