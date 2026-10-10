import { CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { config } from "../server/config.mjs";
import { s3 } from "../server/storage.mjs";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (let attempt = 1; attempt <= 60; attempt++) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: config.s3.bucket }));
    console.log(`storage bucket ready: ${config.s3.bucket}`);
    process.exit(0);
  } catch (headError) {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: config.s3.bucket }));
      console.log(`created storage bucket: ${config.s3.bucket}`);
      process.exit(0);
    } catch (createError) {
      if (["BucketAlreadyExists", "BucketAlreadyOwnedByYou"].includes(createError.name)) {
        console.log(`storage bucket ready: ${config.s3.bucket}`);
        process.exit(0);
      }
      if (attempt === 60) throw createError;
      if (attempt === 1 || attempt % 10 === 0) console.log(`waiting for object storage (${attempt}/60)`);
      await wait(1000);
    }
  }
}
