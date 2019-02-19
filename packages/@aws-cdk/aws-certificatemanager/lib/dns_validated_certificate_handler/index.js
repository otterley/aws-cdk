'use strict';

const aws = require('aws-sdk');
const UuidEncoder = require('uuid-encoder');
const request = require('request-promise-native');

const sleep = function (ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Requests a public certificate from AWS Certificate Manager, using DNS validation.
 * The hosted zone ID must refer to a **public** Route53-managed DNS zone that is authoritative
 * for the suffix of the certificate's Common Name (CN).  For example, if the CN is
 * `*.example.com`, the hosted zone ID must point to a Route 53 zone authoritative
 * for `example.com`.
 *
 * @param {string} requestId the CloudFormation request ID
 * @param {string} domainName the Common Name (CN) field for the requested certificate
 * @param {string} hostedZoneId the Route53 Hosted Zone ID
 * @returns {string} Validated certificate ARN
 */
const requestCertificate = async function (requestId, domainName, subjectAlternativeNames, hostedZoneId) {
  const acm = new aws.ACM();
  const route53 = new aws.Route53();
  const encoder = new UuidEncoder('base36');

  console.log(`Requesting certificate for ${domainName}`);

  const reqCertResponse = await acm.requestCertificate({
    DomainName: domainName,
    SubjectAlternativeNames: subjectAlternativeNames,
    IdempotencyToken: encoder.encode(requestId),
    ValidationMethod: 'DNS'
  }).promise();

  console.log(`Certificate ARN: ${reqCertResponse.CertificateArn}`);

  console.log('Waiting for ACM to provide DNS records for validation...');

  var describeCertResponse;
  let attempt = 0;
  do {
    // Exponential backoff with jitter based on 100ms base
    await sleep(Math.random() * (Math.pow(attempt, 2) * 100));
    describeCertResponse = await acm.describeCertificate({
      CertificateArn: reqCertResponse.CertificateArn
    }).promise();
  } while (describeCertResponse.Certificate.DomainValidationOptions < 1 ||
    'ResourceRecord' in describeCertResponse.Certificate.DomainValidationOptions[0] === false);

  const record = describeCertResponse.Certificate.DomainValidationOptions[0].ResourceRecord;

  console.log(`Upserting DNS record into zone ${hostedZoneId}: ${record.Name} ${record.Type} ${record.Value}`);

  const changeBatch = await route53.changeResourceRecordSets({
    ChangeBatch: {
      Changes: [{
        Action: 'UPSERT',
        ResourceRecordSet: {
          Name: record.Name,
          Type: record.Type,
          TTL: 60,
          ResourceRecords: [{
            Value: record.Value
          }]
        }
      }]
    },
    HostedZoneId: hostedZoneId
  }).promise();

  console.log('Waiting for DNS records to commit...');
  await route53.waitFor('resourceRecordSetsChanged', {
    // Wait up to 5 minutes
    $waiter: {
      delay: 30,
      maxAttempts: 10
    },
    Id: changeBatch.ChangeInfo.Id
  }).promise();

  console.log('Waiting for validation...');
  await acm.waitFor('certificateValidated', {
    // Wait up to 5 minutes
    $waiter: {
      delay: 30,
      maxAttempts: 10
    },
    CertificateArn: reqCertResponse.CertificateArn
  }).promise();

  return reqCertResponse.CertificateArn;
};

/**
 * Deletes a certificate from AWS Certificate Manager (ACM) by its ARN.
 * If the certificate does not exist, the function will return normally.
 *
 * @param {string} arn The certificate ARN
 */
const deleteCertificate = async function (arn) {
  const acm = new aws.ACM();

  console.log(`Deleting certificate ${arn}`);

  try {
    await acm.deleteCertificate({
      CertificateArn: arn
    }).promise();
  } catch (err) {
    if (err.name !== 'ResourceNotFoundException') {
      throw err;
    }
  }
};

/**
 * Main handler, invoked by Lambda
 */
exports.certificateRequestHandler = async function (event, context) {
  var responseData = {};
  var physicalResourceId;
  var certificateArn;

  try {
    switch (event.RequestType) {
      case 'Create':
      case 'Update':
        certificateArn = await requestCertificate(
          event.RequestId,
          event.ResourceProperties.DomainName,
          event.ResourceProperties.SubjectAlternativeNames,
          event.ResourceProperties.HostedZoneId
        );
        responseData.Arn = physicalResourceId = certificateArn;
        break;
      case 'Delete':
        physicalResourceId = event.PhysicalResourceId;
        // If the resource didn't create correctly, the physical resource ID won't be the
        // certificate ARN, so don't try to delete it in that case.
        if (physicalResourceId.startsWith('arn:')) {
          await deleteCertificate(physicalResourceId);
        }
        break;
      default:
        throw new Error(`Unsupported request type ${event.RequestType}`);
    }

    console.log(`Uploading SUCCESS response to S3...`);

    await request({
      uri: event.ResponseURL,
      method: 'PUT',
      body: {
        Status: 'SUCCESS',
        PhysicalResourceId: physicalResourceId,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId,
        Data: responseData
      },
      headers: {
        // This is required to ensure the presigned S3 URL signature matches
        'Content-Type': ''
      },
      json: true,
      followAllRedirects: true,
      followOriginalHttpMethod: true
    });

    console.log('Done.');
  } catch (err) {
    console.log(`Caught error ${err}. Uploading FAILED message to S3.`);
    await request({
      uri: event.ResponseURL,
      method: 'PUT',
      body: {
        Status: 'FAILED',
        Reason: err.message,
        PhysicalResourceId: physicalResourceId,
        StackId: event.StackId,
        RequestId: event.RequestId,
        LogicalResourceId: event.LogicalResourceId
      },
      headers: {
        // This is required to ensure the presigned S3 URL signature matches
        'Content-Type': ''
      },
      json: true,
      followAllRedirects: true,
      followOriginalHttpMethod: true
    });
  }
};
