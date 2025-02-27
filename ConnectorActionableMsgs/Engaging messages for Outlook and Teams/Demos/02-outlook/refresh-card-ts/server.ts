import * as Express from 'Express';
import * as BodyParser from "body-parser";
import * as http from 'http';
import * as Validator from './Utilities/ActionableMessageTokenValidator';
import * as ACData from "adaptivecards-templating";
import * as morgan from 'morgan';
import * as debug from 'debug';

// init console logging module
const log = debug('msoutlook-adaptivecards');
log(`Initializing Outlook Actionable Messages Adaptive Card service...`);

// init dotenv to obtain environment variables
//  it will use the:
//    (1) .env file if present or
//    (2) host process
require('dotenv').config();

// load environment settings
const PORT: any = process.env.port || process.env.PORT || 3007;
const HOSTNAME: string = process.env.host || process.env.HOSTNAME || 'http://localhost';
const ALLOWED_SENDER: string = process.env.ALLOWED_SENDER || 'john.doe@contoso.com';
const ACTION_PERFORMER_DOMAIN: string = process.env.ACTION_PERFORMER_DOMAIN || 'contoso.com';


log(`ENVVAR - PORT: ${PORT}`);
log(`ENVVAR - HOSTNAME: ${HOSTNAME}`);
log(`ENVVAR - ALLOWED_SENDER: ${ALLOWED_SENDER}`);
log(`ENVVAR - ACTION_PERFORMER_DOMAIN: ${ACTION_PERFORMER_DOMAIN}`);

// setup web server
const express = Express();

// setup parsing body as JSON
express.use(BodyParser.json());

// add simple logging
express.use(morgan('tiny'));

// set port
express.set('port', PORT);

// start the web server
http.createServer(express).listen(PORT, () => {
  log(`Server running on ${PORT}`);
});

// setup API endpoint
express.post('/api/card', (request: Express.Request, response: Express.Response, callback) => {
  let token: string | undefined = undefined;

  // get the auth token from the "AUTHORIZATION" request header
  if (request.headers && request.headers.authorization) {
    let authHeaderArray: string[] = request.headers.authorization.trim().split(' ');
    if (authHeaderArray.length === 2 && authHeaderArray[0].toLowerCase() === 'bearer') {
      token = authHeaderArray[1];
    }
  }

  // if no token received, respond with HTTP 401
  if (token === undefined) {
    response.status(401);
    response.end();
    return;
  }

  // validate the token sender & parse if valid
  const validator = new Validator.ActionableMessageTokenValidator();
  validator.validateToken(
    token,
    `https://${HOSTNAME}`,
    (error: Error, result: Validator.ActionableMessageTokenValidatorResult) => {
      // if token isn't valid, respond with HTTP 401 & specific error message why it failed
      if (error) {
        response.status(401).send(error.message);
        response.end();
        return;
      }

      // while token is valid, verify it was sent from the allowed senders & an allowed domain
      if (result.sender?.toLowerCase() !== ALLOWED_SENDER || !result.actionPerformer?.toLowerCase().endsWith(ACTION_PERFORMER_DOMAIN)) {
        response.set('CARD-ACTION-STATUS', 'Invalid sender or the action performer is not allowed.');
        response.status(403);
        response.end();
        return;
      }

      /*
      * at this point...
      *  1) by validating the token, we've confirmed the request was sent by Microsoft
      *  2) the sender of the original email & domain it was sent from are from values we expect
      *
      * this means the API can record the submission & respond with a card that Outlook
      * will use to refresh the email to provide the user feedback on their submission
      */

      // load sample feedback
      let feedback: { name: string, rating: number, comment: string }[] = require('./fake-feedback.json');

      // add newly submitted feedback
      log("HTTP POST request.body contents", request.body);
      let feedbackResponse = request.body;
      // add the user's name to the response
      // NOTE: for simplicity, we're using their email, but you could use
      //       Microsoft Graph to obtain the user's real name for a better experience
      feedbackResponse.name = result.sender;
      feedback.push(feedbackResponse);

      // create data structure for Adaptive Card
      let cardData: ACData.IEvaluationContext = {
        $root: {
          average_rating: feedback
            .map((feedbackReply) => {
              return feedbackReply.rating
            })
            .reduce((total, rating) => {
              return total + rating;
            }, 0) / feedback.length,
          feedback: feedback,
          total_responses: feedback.length
        }
      };

      // load the template Adaptive Card response
      let cardSource: any = require('./response-card.json');
      const cardTemplate = new ACData.Template(cardSource);

      // generate the Adaptive Card response by merging the template with the data
      const cardExpanded = cardTemplate.expand(cardData);

      // respond to Outlook with the refresh card source
      response.set('CARD-ACTION-STATUS', 'The webinar feedback was received.');
      response.set('CARD-UPDATE-IN-BODY', 'true');
      response.status(200).send(cardExpanded);
      response.end();
    }
  );
});
