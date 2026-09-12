/**
 * S3 Service for Media Upload – Pre-Signed URLs (Epic 8)
 */

import crypto from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { FastifyBaseLogger } from "fastify";

interface S3Config {
  bucket: string;
  region: string;
  internalEndpoint: string | undefined;
  publicEndpoint: string | undefined;
  forcePathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

interface PresignedUrlResult {
  uploadUrl: string;
  objectKey: string;
  expiresIn: number;
}

export class S3Service {
  private readonly config: S3Config;
  private readonly internalClient: S3Client;
  private readonly publicClient: S3Client;
  private readonly logger: FastifyBaseLogger;

  constructor(logger: FastifyBaseLogger) {
    this.logger = logger.child({ module: "S3Service" });
    const internalEndpoint = process.env["S3_ENDPOINT"];
    const publicEndpoint = process.env["S3_PUBLIC_ENDPOINT"];
    this.config = {
      bucket: process.env["S3_BUCKET"] ?? "via-romae-media",
      region: process.env["S3_REGION"] ?? "eu-central-1",
      internalEndpoint,
      publicEndpoint,
      forcePathStyle: process.env["S3_FORCE_PATH_STYLE"]
        ? process.env["S3_FORCE_PATH_STYLE"] === "true"
        : Boolean(internalEndpoint),
      accessKeyId: process.env["S3_ACCESS_KEY_ID"] ?? process.env["S3_ACCESS_KEY"] ?? "",
      secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] ?? process.env["S3_SECRET_KEY"] ?? "",
    };

    if (!this.config.accessKeyId || !this.config.secretAccessKey) {
      this.logger.warn("S3 credentials not configured – uploads will fail");
    }

    const shared = {
      region: this.config.region,
      forcePathStyle: this.config.forcePathStyle,
      credentials: {
        accessKeyId: this.config.accessKeyId,
        secretAccessKey: this.config.secretAccessKey,
      },
    };
    this.internalClient = new S3Client({
      ...shared,
      ...(internalEndpoint ? { endpoint: internalEndpoint } : {}),
    });
    // Signing against this client makes the externally reachable host and any
    // endpoint path part of the canonical request. Never substitute hosts after signing.
    this.publicClient = new S3Client({
      ...shared,
      ...(publicEndpoint ? { endpoint: publicEndpoint } : {}),
    });
  }

  async generatePresignedUploadUrl(
    teamId: string,
    questRunId: string,
    fileType: string,
    fileSizeBytes: number,
  ): Promise<PresignedUrlResult> {
    this.assertPublicEndpointConfigured();
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const objectKey = `team/${teamId}/quest/${questRunId}/${timestamp}_${crypto.randomBytes(16).toString("hex")}.${this.getFileExtension(fileType)}`;
    const expiresIn = 3600;
    const uploadUrl = await getSignedUrl(
      this.publicClient,
      new PutObjectCommand({ Bucket: this.config.bucket, Key: objectKey, ContentType: fileType }),
      { expiresIn },
    );

    this.logger.info({ objectKey, fileType, fileSizeBytes }, "Generated pre-signed upload URL");
    return { uploadUrl, objectKey, expiresIn };
  }

  async validateObject(objectKey: string, mimeType: string, expectedSize: number): Promise<boolean> {
    try {
      const result = await this.internalClient.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: objectKey,
      }));
      return result.ContentLength === expectedSize && result.ContentType?.split(";")[0] === mimeType;
    } catch (error) {
      this.logger.warn({ objectKey, error }, "S3 object validation failed");
      return false;
    }
  }

  async generatePresignedDownloadUrl(objectKey: string): Promise<string> {
    this.assertPublicEndpointConfigured();
    return getSignedUrl(this.publicClient, new GetObjectCommand({
      Bucket: this.config.bucket,
      Key: objectKey,
    }), { expiresIn: 900 });
  }

  async deleteObject(objectKey: string): Promise<void> {
    await this.internalClient.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: objectKey }));
  }

  private assertPublicEndpointConfigured(): void {
    if (this.config.internalEndpoint && !this.config.publicEndpoint) {
      throw new Error("S3_PUBLIC_ENDPOINT is required when S3_ENDPOINT is configured; internal storage hostnames must not be exposed to clients");
    }
  }

  private getFileExtension(mimeType: string): string {
    const map: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "video/mp4": "mp4",
      "video/quicktime": "mov",
    };
    return map[mimeType] ?? "bin";
  }
}
