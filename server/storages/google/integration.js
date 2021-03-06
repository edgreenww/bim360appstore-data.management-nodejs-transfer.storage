/////////////////////////////////////////////////////////////////////
// Copyright (c) Autodesk, Inc. All rights reserved
// Written by Forge Partner Development
//
// Permission to use, copy, modify, and distribute this software in
// object code form for any purpose and without fee is hereby granted,
// provided that the above copyright notice appears in all copies and
// that both that copyright notice and the limited warranty and
// restricted rights notice below appear in all supporting
// documentation.
//
// AUTODESK PROVIDES THIS PROGRAM "AS IS" AND WITH ALL FAULTS.
// AUTODESK SPECIFICALLY DISCLAIMS ANY IMPLIED WARRANTY OF
// MERCHANTABILITY OR FITNESS FOR A PARTICULAR USE.  AUTODESK, INC.
// DOES NOT WARRANT THAT THE OPERATION OF THE PROGRAM WILL BE
// UNINTERRUPTED OR ERROR FREE.
/////////////////////////////////////////////////////////////////////

'use strict'; // http://www.w3schools.com/js/js_strict.asp

// token handling in session
var Credentials = require('./../../credentials');
// forge config information, such as client ID and secret
var config = require('./../../config');

// web framework
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
var jsonParser = bodyParser.json();

var Encoder = require('node-html-encoder').Encoder;
var encoder = new Encoder('entity');

var googleSdk = require('googleapis');
const {google} = require('googleapis');

var request = require('request');

var utility = require('./../utility');

/// create a folder at the parent folder if it doesn't exist
router.post('/api/storage/createFolder', jsonParser, function (req, res) {
  var token = new Credentials(req.session);
  if (token.getStorageCredentials() === undefined) {
    res.status(401).end();
    return;
  }

  //var oauth2Client = new googleSdk.auth.OAuth2(
  var oauth2Client =  new google.auth.OAuth2(
    config.storage.credentials.client_id,
    config.storage.credentials.client_secret,
    config.storage.callbackURL);
  oauth2Client.setCredentials(token.getStorageCredentials());
  // var drive = googleSdk.drive({version: 'v2', auth: oauth2Client}); // not sure why, v2 works for list, not for create
  var drive = google.drive({version: 'v3', auth: oauth2Client});

  var parentFolder = req.body.parentFolder;
  var folderName = encoder.htmlDecode(req.body.folderName);

  if (parentFolder === '' || folderName === '') {
    res.status(500).end('Invalid parentId or folderName');
    return;
  }

  drive.files.list({
    q: '\''+ (parentFolder==='#' ? 'root' : parentFolder ) +'\' in parents and name = \''+ folderName + '\' and mimeType = \'application/vnd.google-apps.folder\' and trashed = false',
    fields: 'nextPageToken, files(id,name)'
  }, function (err, lst) {
    if (err) console.log('error here:', err);
    console.log('lst', lst) // <-- lst is undefined
    if (lst.data !=null && lst.data.files.length==1){  // <-- here is the problem
      res.json({folderId: lst.files[0].id});
      return;
    }

    var fileMetadata = {
      'name': folderName,
      'mimeType': 'application/vnd.google-apps.folder',
      'parents': null
    };

    if (parentFolder != '#')
      fileMetadata.parents = [parentFolder];

    // drive = googleSdk.drive({version: 'v3', auth: oauth2Client}); // not sure why, v3 works for create, not for list
    drive = google.drive({version: 'v3', auth: oauth2Client});
    drive.files.create({
      resource: fileMetadata,
      fields: 'id'
    }, function (err, file) {
      if (err) {
        // Handle errorjstree
        console.log(err.message);
        res.status(500).end();
      } else {
        res.json({folderId: file.id});
      }
    });
  });
});

router.post('/api/storage/transferTo', jsonParser, function (req, res) {
  var token = new Credentials(req.session);
  if (token.getStorageCredentials() === undefined || token.getForgeCredentials() === undefined) {
    res.status(401).end();
    return;
  }

  utility.assertIsVersion(req.body.autodeskItem, req, function (autodeskVersionId) {
    utility.getVersion(autodeskVersionId, req, function (version) {
      var storageFolder = req.body.storageFolder;

      // Google API first need to create an entry, then upload
      request({
        url: 'https://www.googleapis.com/drive/v3/files',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token.getStorageCredentials().access_token
        },
        body: JSON.stringify({
          name: version.attributes.displayName,
          parents: [storageFolder]
        })
      }, function (error, response, file) {
        var newFile = JSON.parse(response.body);

        // now with the file created, let's prepare the transfer job\
        var source = {
          url: version.relationships.storage.meta.link.href,
          method: "GET",
          headers: {
            'Authorization': 'Bearer ' + token.getForgeCredentials().access_token
          },
          encoding: null
        };

        var destination = {
          url: 'https://www.googleapis.com/upload/drive/v2/files/' + newFile.id + '?uploadType=media',
          method: 'PUT',
          headers: {
            'Content-Type': newFile.mimeType,
            'Authorization': 'Bearer ' + token.getStorageCredentials().access_token
          }
        };

        // send Lambda job
        var id = utility.postLambdaJob(source, destination, token);

        res.json({taskId: id, status: utility.TRANSFER_STATUS.RECEIVED});
      });
    });
  });
});

router.post('/api/storage/transferFrom', jsonParser, function (req, res) {
  // >>>
  var token = new Credentials(req.session);
  if (token.getStorageCredentials() === undefined || token.getForgeCredentials() === undefined) {
    res.status(401).end();
    return;
  }

  utility.assertIsFolder(req.body.autodeskFolder, req, function (autodeskProjectId, autodeskFolderId) {
    //<<<

    // for Google we receive the FileID, let's get info about the file
    var googleFileId = req.body.storageItem;
   //  var oauth2Client = new googleSdk.auth.OAuth2(
    var oauth2Client =  new google.auth.OAuth2(
      config.storage.credentials.client_id,
      config.storage.credentials.client_secret,
      config.storage.callbackURL);
    oauth2Client.setCredentials(token.getStorageCredentials());
    // var drive = googleSdk.drive({version: 'v2', auth: oauth2Client});
    var drive = google.drive({version: 'v3', auth: oauth2Client});
    drive.files.get({
      fileId: googleFileId
    }, function (err, fileInfo) {
      var fileName = fileInfo.title; // name, that's all we need from Google

      // >>>
      utility.prepareAutodeskStorage(autodeskProjectId, autodeskFolderId, fileName, req, function (autodeskStorageUrl, skip, callbackData) {
        if (skip) {
          res.status(409).end(); // no action (server-side)
          return;
        }
        //<<<

        var source = {
          url: 'https://www.googleapis.com/drive/v2/files/' + googleFileId + '?alt=media',
          method: "GET",
          headers: {
            'Authorization': 'Bearer ' + token.getStorageCredentials().access_token
          },
          encoding: null
        };

        var destination = {
          url: autodeskStorageUrl,
          method: "PUT",
          headers: {
            'Authorization': 'Bearer ' + token.getForgeCredentials().access_token
          },
          encoding: null
        };

        // send Lambda job
        var id = utility.postLambdaJob(source, destination, token, callbackData /*returned from prepareAutodeskStorage, used to setup item/version */);

        res.json({taskId: id, status: utility.TRANSFER_STATUS.RECEIVED });
      });
    });
  });
});


module.exports = router;