import {
  LexRuntimeV2Client,
  RecognizeTextCommand,
} from "@aws-sdk/client-lex-runtime-v2";
import { Client } from "@opensearch-project/opensearch";
import { AwsSigv4Signer } from "@opensearch-project/opensearch/aws";
import { defaultProvider } from "@aws-sdk/credential-provider-node";

const INDEX = "photos";
const REGION = "us-east-1";
const ES_ENDPOINT = process.env.ES_ENDPOINT; // OpenSearch domain URL
const LEX_BOT_ID = "1E2BVRIYW8"; // Your Lex bot ID
// const LEX_ALIAS_ID = "R919KENBHU"; // Lex alias ID
const LEX_ALIAS_ID = "TSTALIASID";

const lexClient = new LexRuntimeV2Client({ region: REGION });

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

// // Function to send a message to Lex V2
const postToBot = async (event) => {
  const msg =
    event.queryStringParameters?.query || "I need photos with dogs and cats";

  const params = {
    botId: LEX_BOT_ID,
    botAliasId: LEX_ALIAS_ID,
    localeId: "en_US",
    sessionId: "testsession",
    text: msg,
  };

  try {
    const command = new RecognizeTextCommand(params);

    const response = await lexClient.send(command);
    console.log(
      `Received response from Lex: ${JSON.stringify(response, null, 2)}`
    );

    return response;
  } catch (error) {
    console.error("Error communicating with Lex:", error);
    throw error;
  }
};

// Query OpenSearch for labels
const queryOS = async (keywords) => {
  const query = {
    query: {
      bool: {
        should: [],
      },
    },
  };

  // Add each keyword to the query's "should" array
  keywords.forEach((keyword) => {
    query.query.bool.should.push({
      match: {
        labels: {
          query: keyword,
          fuzziness: "AUTO",
        },
      },
    });
  });

  try {
    const response = await osClient.search({
      index: INDEX,
      body: query,
    });

    return response;
  } catch (error) {
    console.error(
      `Error retrieving images having labels ${keywords} from OpenSearch:`,
      error
    );
    return null;
  }
};

const getImgURL = (osResponse) => {
  const imgURLs = [];
  try {
    const hits = osResponse.body.hits.hits;
    hits.forEach((each) => {
      const objectKey = each._source.objectKey;
      const bucket = each._source.bucket;
      const imageUrl = `https://${bucket}.s3.amazonaws.com/${objectKey}`;
      imgURLs.push(imageUrl);
    });
    return imgURLs;
  } catch (error) {
    console.error(
      `Error extracting image urls from OpenSearch response:`,
      error
    );
    return [];
  }
};

export const handler = async (event) => {
  console.log("lf2 triggered with payload:", JSON.stringify(event));
  try {
    const lexResponse = await postToBot(event);

    // Extract keywords from Lex interpretation
    const slots = lexResponse.interpretations[0]?.intent?.slots || {};
    const keywords = Object.values(slots)
      .filter((slot) => slot.value?.interpretedValue)
      .map((slot) => slot.value.interpretedValue);

    console.log("Extracted keywords:", keywords);

    // Step 2: Query OpenSearch
    const osResponse = await queryOS(keywords);
    console.log("OpenSearch response:", JSON.stringify(osResponse));

    const imgURLs = getImgURL(osResponse);
    const response = {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*", // Or specify the exact domain
        "Access-Control-Allow-Methods": "GET",
        "Access-Control-Allow-Headers": "Content-Type,x-api-key",
      },
      body: JSON.stringify({ message: "Success", results: imgURLs }),
    };

    return response;
  } catch (error) {
    console.error("Error processing search:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Error processing search query" }),
    };
  }
};
