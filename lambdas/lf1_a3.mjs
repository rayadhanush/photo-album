import { Client } from "@opensearch-project/opensearch"; // add opensearch layer to lambda
import { S3Client, HeadObjectCommand } from "@aws-sdk/client-s3";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import {
  RekognitionClient,
  DetectLabelsCommand,
} from "@aws-sdk/client-rekognition";

const INDEX = "photos";
const REGION = "us-east-1";
const ES_ENDPOINT = process.env.ES_ENDPOINT; // AWS Opensearch domain url

const s3Client = new S3Client();
const rekognitionClient = new RekognitionClient({ region: REGION });

//Initialize client to communicate with Opensearch
const osClient = new Client({
  ...AwsSigv4Signer({
    region: REGION,
    service: "es",
    getCredentials: () => {
      const credentialsProvider = defaultProvider();
      return credentialsProvider();
    },
  }),
  node: ES_ENDPOINT,
});

// Function to insert data into OpenSearch
const insertToOpenSearch = async (document) => {
  try {
    await osClient.index({
      id: document.objectKey,
      index: INDEX,
      body: document,
      refresh: true,
    });

    console.log(`Successfully inserted: ${document.objectKey}`);
  } catch (error) {
    console.error(`Error inserting ${document.objectKey}:`, error);
  }
};

// Function to retrieve custom labels from S3 object metadata
const retrieveCustomLabels = async (bucket, key) => {
  try {
    const headObjectResponse = await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: key })
    );

    console.log("head obj resp: ", headObjectResponse);

    const customLabels = headObjectResponse["$metadata"][
      "x-amz-meta-customlabels"
    ]
      ? headObjectResponse["$metadata"]["x-amz-meta-customlabels"].split(",")
      : [];

    console.log(`Successfully retrieved custom labels for s3 object: ${key}`);

    return customLabels;
  } catch (error) {
    console.error(`Error getting custom labels for s3 object ${key}:`, error);
    return [];
  }
};

const detectLabels = async (bucket, key) => {
  try {
    console.log("inside detectLabels");
    const requestObj = {
      Image: {
        S3Object: {
          Bucket: bucket,
          Name: key,
        },
      },
      MaxLabels: 10,
    };

    console.log("requestObj:", requestObj);
    const rekognitionResponse = await rekognitionClient.send(
      new DetectLabelsCommand(requestObj)
    );

    const labels = rekognitionResponse.Labels.map((label) => label.Name);

    console.log(
      `Successfully fetched labels from Rekognition for s3 object: ${key}`
    );
    return labels;
  } catch (error) {
    console.error(
      `Error getting labels from Rekognition for s3 object ${key}:`,
      error
    );
    return [];
  }
};

export const handler = async (event) => {
  console.log(JSON.stringify(event));
  try {
    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

      console.log(`key: ${key}`);

      // Detect labels using Rekognition
      const labels = await detectLabels(bucket, key);

      const customLabels = await retrieveCustomLabels(bucket, key);

      // Combine Rekognition labels and custom labels
      const allLabels = Array.from(new Set([...labels, ...customLabels]));

      // Create a JSON document for Elasticsearch
      const document = {
        objectKey: key,
        bucket: bucket,
        createdTimestamp: new Date().toISOString(),
        labels: allLabels,
      };

      console.log(JSON.stringify(document));

      // Index the document in Elasticsearch
      await insertToOpenSearch(document);
    }

    return {
      statusCode: 200,
      body: JSON.stringify("Indexing complete!"),
    };
  } catch (error) {
    console.error("Error processing event:", error);
    return {
      statusCode: 500,
      body: JSON.stringify("Error indexing photos"),
    };
  }
};
