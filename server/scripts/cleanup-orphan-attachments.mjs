import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:60033/?replicaSet=testset';
const BUCKET = process.env.UPLOADS_BUCKET;
const REGION = process.env.AWS_REGION || 'ap-south-1';

async function run() {
  const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');

  if (!BUCKET) {
    console.error('UPLOADS_BUCKET env var is required.');
    process.exit(1);
  }

  await mongoose.connect(MONGODB_URI);
  console.log('Connected to MongoDB.');

  const HelpAttachment = mongoose.model(
    'HelpAttachment',
    new mongoose.Schema(
      {
        ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'HelpTicket' },
        commentId: { type: mongoose.Schema.Types.ObjectId, ref: 'HelpComment' },
        uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        fileName: String,
        mimeType: String,
        sizeBytes: Number,
        s3Key: { type: String, required: true },
        status: { type: String, default: 'pending' },
      },
      { timestamps: true },
    ),
  );

  const confirmed = await HelpAttachment.find({ status: 'confirmed' }).select('s3Key fileName status');
  console.log(`Found ${confirmed.length} confirmed attachment(s) to check.`);

  const s3 = new S3Client({ region: REGION });
  let orphanCount = 0;

  for (const att of confirmed) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: att.s3Key }));
    } catch (err) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        console.log(`  ORPHAN: ${att.fileName} (${att.s3Key})`);
        att.status = 'deleted';
        await att.save();
        orphanCount++;
      } else {
        console.error(`  ERROR checking ${att.fileName}: ${err.message}`);
      }
    }
  }

  console.log(`\nDone. Marked ${orphanCount} orphaned attachment(s) as deleted.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Script failed:', err);
  process.exit(1);
});
