import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {getSignedUrl} from "@aws-sdk/s3-request-presigner";
import {readFileSync} from "fs";

interface StorageConfig {
  endpoint: string;
  region: string;
  key: string;
  secret: string;
  bucket: string;
  forcePathStyle: boolean;
}

function normaliseEndpoint(endpoint: string): string {
  return endpoint.startsWith("http://") || endpoint.startsWith("https://")
    ? endpoint
    : `https://${endpoint}`;
}

function getStorageConfig(): StorageConfig | null {
  const railwayEndpoint = process.env.BUCKET_ENDPOINT ?? process.env.ENDPOINT;
  const railwayBucket = process.env.BUCKET_NAME ?? process.env.BUCKET;
  const railwayKey = process.env.BUCKET_ACCESS_KEY_ID ?? process.env.ACCESS_KEY_ID;
  const railwaySecret = process.env.BUCKET_SECRET_ACCESS_KEY ?? process.env.SECRET_ACCESS_KEY;
  const railwayRegion = process.env.BUCKET_REGION ?? process.env.REGION ?? "auto";

  if (railwayEndpoint && railwayBucket && railwayKey && railwaySecret) {
    const isAws = railwayEndpoint.includes("amazonaws.com");
    const secret = railwaySecret;
    console.log(`[storage] endpoint=${railwayEndpoint} bucket=${railwayBucket} key=${railwayKey.slice(0,8)}... secret_len=${secret.length} secret_end=${secret.slice(-6)} forcePathStyle=${!isAws}`);
    return {
      endpoint: normaliseEndpoint(railwayEndpoint),
      region: railwayRegion,
      key: railwayKey,
      secret,
      bucket: railwayBucket,
      forcePathStyle: process.env.BUCKET_FORCE_PATH_STYLE === "true" || !isAws,
    };
  }

  const endpoint = process.env.DO_SPACES_ENDPOINT;
  const region = process.env.DO_SPACES_REGION ?? "fra1";
  const key = process.env.DO_SPACES_KEY;
  const secret = process.env.DO_SPACES_SECRET;
  const bucket = process.env.DO_SPACES_BUCKET;

  if (!endpoint || !key || !secret || !bucket) return null;

  return {
    endpoint: normaliseEndpoint(endpoint),
    region,
    key,
    secret,
    bucket,
    forcePathStyle: false,
  };
}

function getClient() {
  const config = getStorageConfig();
  if (!config) return null;

  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: { accessKeyId: config.key, secretAccessKey: config.secret },
    forcePathStyle: config.forcePathStyle,
  });
}

export function spacesEnabled(): boolean {
  return getStorageConfig() !== null;
}

export async function uploadToSpaces(
  localPath: string,
  key: string,
  contentType: string
): Promise<string> {
  const client = getClient();
  const config = getStorageConfig();
  if (!client || !config) throw new Error("Object storage not configured");

  const body = readFileSync(localPath);
  await client.send(
    new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    })
  );

  const endpointUrl = new URL(config.endpoint);
  return `${endpointUrl.protocol}//${config.bucket}.${endpointUrl.host}/${key}`;
}

export async function deleteFromSpaces(key: string): Promise<void> {
  const client = getClient();
  const config = getStorageConfig();
  if (!client || !config) return;

  await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

export async function getSpacesSignedUrl(key: string, expiresIn = 3600): Promise<string> {
  const client = getClient();
  const config = getStorageConfig();
  if (!client || !config) throw new Error("Object storage not configured");

  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.bucket, Key: key }),
    { expiresIn }
  );
}

export async function fileExistsInSpaces(key: string): Promise<boolean> {
  const client = getClient();
  const config = getStorageConfig();
  if (!client || !config) return false;

  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}
