import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config.js";
import { unavailable } from "../errors.js";

/** Armazenamento das fotos de check-in (bucket S3 privado, acesso só por URL assinada). */
export interface PhotoStorage {
  put(path: string, body: Buffer, contentType: string): Promise<void>;
  remove(path: string): Promise<void>;
  signedUrl(path: string, ttlSeconds: number): Promise<string>;
  /** Soma dos bytes e quantidade de objetos sob o prefixo (ex.: o id do hospital). */
  usage(prefix: string): Promise<{ bytes: number; count: number }>;
}

export function criarStorageS3(config: Config): PhotoStorage {
  const bucket = config.CHECKIN_PHOTOS_BUCKET;
  if (!bucket) return storageIndisponivel();
  const s3 = new S3Client({ region: config.AWS_REGION });

  return {
    async put(path, body, contentType) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: path,
          Body: body,
          ContentType: contentType,
          ServerSideEncryption: "AES256",
        }),
      );
    },
    async remove(path) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: path }));
    },
    signedUrl(path, ttlSeconds) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: path }), { expiresIn: ttlSeconds });
    },
    async usage(prefix) {
      let bytes = 0;
      let count = 0;
      let token: string | undefined;
      for (let pagina = 0; pagina < 20; pagina++) {
        const r = await s3.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/`, ContinuationToken: token }),
        );
        for (const o of r.Contents ?? []) {
          bytes += o.Size ?? 0;
          count += 1;
        }
        if (!r.IsTruncated) break;
        token = r.NextContinuationToken;
      }
      return { bytes, count };
    },
  };
}

export function storageIndisponivel(): PhotoStorage {
  const falha = () => {
    throw unavailable("Armazenamento de fotos não configurado.");
  };
  return {
    put: async () => falha(),
    remove: async () => falha(),
    signedUrl: async () => falha(),
    usage: async () => falha(),
  };
}
