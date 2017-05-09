///////////////////////////////////////////////////////////
//
// Synchronizes ticket data from drupal to Spark.
//
///////////////////////////////////////////////////////////

var request = require('request');
var parseStringSync = require('xml2js-parser').parseStringSync;
var dateFormat = require('dateformat');
var _ = require('lodash');
var log = require('../libs/logger')(module);

var User = require('../models/user.js').User;
var Ticket = require('../models/ticket.js').Ticket;

const TICKETS_TYPE_IDS = [38, 39, 40];
const STATUS_COMPLETED = 'Completed';

const EVENT_ID = "MIDBURN2017";
var globalMinutesDelta = 0;

function r(options) {
    return new Promise(resolve => {
        request(options, (error, response, body) => {
            resolve({response: response, body: body, error: error});
        });
    });
}

async function getDrupalSession(callback) {
    var headers = {
        'content-type': 'application/x-www-form-urlencoded',
        'cache-control': 'no-cache'
    };

    var options = {
        url: process.env.DRUPAL_PROFILE_API_URL + '/en/api/user/login',
        method: 'POST',
        headers: headers,
        form: {'username': process.env.DRUPAL_PROFILE_API_USER, 'password': process.env.DRUPAL_PROFILE_API_PASSWORD}
    };

    var x = await r(options);
    if (x.response && x.response.statusCode === 302) {
        var bodyJson = JSON.parse(x.body);
        session = {sessid: bodyJson["sessid"], session_name: bodyJson["session_name"]};
        log.info("Session info:" + JSON.stringify(session));
        return session;
    }
    else {
        log.warn("Getting Drupal session key failed");
    }
}

async function dumpDrupalTickets(session, date) {

    log.info("Dumping tickets changed after", dateFormat(date, "yyyy-mm-dd hh:MM:ss"));

    var headers = {
        'cache-control': 'no-cache',
        'x-csrf-token': session.sessid,
        'Accept': '*/*',
        'cookie': session.session_name + "=" + session.sessid
    };

    var options = {
        url: process.env.DRUPAL_PROFILE_API_URL + '/en/api/ticket_export',
        method: 'GET',
        headers: headers,
        qs: {changed: dateFormat(date, "yyyy-mm-dd hh:MM:ss")}
    };

    var x = await r(options);
    if (x.response && x.response.statusCode === 302) {
        var result = parseStringSync(x.body);
        var tickets = result['result']['item'];
        if (!tickets) {
            log.info("Didn't get ticket updates from Drupal");
            return null;
        }
        log.info("got " + tickets.length + " tickets");
        var utickets = [];
        for (var ticket of tickets) {
            var status = ticket['Ticket_State'][0];
            var type_id = parseInt(ticket['ticket_registration_bundle'][0]);
            //log.debug("type", type_id, ticket['user_ticket_type_name'][[0]], status);
            if (status === STATUS_COMPLETED && TICKETS_TYPE_IDS.includes(type_id)) {
                var uticket = {};
                uticket['holder_email'] = ticket['Email'][0];
                uticket['buyer_email'] = ticket['Buyer_E_mail'][0];
                uticket['name'] = ticket['Name'][0];
                uticket['id'] = ticket['Docment_id'][0];
                uticket['order_id'] = ticket['users_ticket_registration_uid'][0];
                uticket['ticket_id'] = ticket['Ticket_number'][0];
                uticket['ticket_number'] = ticket['Ticket_number'][0];
                uticket['barcode'] = ticket['ticket_barcode'][0];
                uticket['document_id'] = ticket['Docment_id'][0];
                uticket['ticket_type'] = ticket['user_ticket_type_name'][0];
                utickets.push(uticket);
            }
        }
        return utickets;
    }
    else {
        log.warn("Ticket dump failed");
    }
}

async function updateAllTickets(tickets) {
    log.info("need to update " + tickets.length + " tickets");
    var counter = 1;
    for (ticket of tickets) {
        //log.info("Updating ticket #", counter++);
        var order_id = ticket['order_id'];
        var ticket_id = ticket['ticket_id'];
        var barcode = ticket['barcode'];
        var email = ticket['holder_email'];
        log.info("Found ticket #", counter++, "- email:" + email + " orderId:" + order_id + " ticketId:" + ticket_id + " barcode:" + barcode);
        ticket = _.clone(ticket);
        await updateTicket(ticket);
    }
}

async function updateTicket(ticket) {
    var holder_email = ticket['holder_email'];
    var order_id = ticket['order_id'];
    var ticket_id = ticket['ticket_id'];
    var barcode = ticket['barcode'];
    var ticket_type = ticket['ticket_type'];

    if (typeof ticket['barcode'] !== "string" || ticket['barcode'].length === 0) {
        log.info("No barcode for ticket", ticket_id, "user ", holder_email);
        return;
    }
    else {
        log.info("Updating ticket", ticket_id, "user ", holder_email);
    }

    try {
        var user = await User.forge({email: holder_email}).fetch();
        if (user == null) {
            // We need to create a new user...
            log.info("User", holder_email, "not found in Spark. Creating...");
            user = await User.forge({
                first_name: ticket["name"].split(' ')[0] || "",
                last_name: ticket["name"].split(' ')[1] || "",
                email: ticket["holder_email"],
                israeli_id: ticket["id"]
            }).save();

            log.info("User", ticket["holder_email"], "created!");
        }
        else {
            log.info("User", ticket["holder_email"], "exists.");

        }

        var sparkTicket = await Ticket.forge({ticket_id: ticket_id}).fetch();
        var saveOptions = {};
        if (sparkTicket != null) {
            log.info("Updating ticket", ticket_id);
        }
        else {
            log.info("Creating ticket", ticket_id);
            saveOptions = {method: 'insert'};
        }

        var holder_id = user.attributes.user_id;
        sparkTicket = Ticket.forge({
            event_id: EVENT_ID,
            holder_id: holder_id,
            barcode: barcode,
            order_id: order_id,
            ticket_id: ticket_id,
            type: ticket_type,
            ticket_number: ticket_id // In Drupal, they are the same
        });

        await sparkTicket.save(null, saveOptions);
        log.info("Ticket update success for ticket", ticket_id);
    }
    catch (err) {
        log.error("ERROR:", err);
    }
}

function sendPassTicketRequest(session, barcode) {
    var headers = {
        'cache-control': 'no-cache',
        'x-csrf-token': session["sessid"],
        'Accept': '*/*',
        'cookie': session["session_name"] + "=" + session["sessid"]
    };

    var options = {
        url: process.env.DRUPAL_PROFILE_API_URL + '/en/api/ticket/' + barcode + '/pass',
        method: 'POST',
        headers: headers
    };
    log.info('Passing ticket with barcode', barcode);
    request(options, function (error, response, body) {
        if (error) {
            log.error(error);
        }
        var result = parseStringSync(body);
        log.info(result['result'])
    })
}

async function passTicket(barcode) {
    var session = await getDrupalSession();
    sendPassTicketRequest(session, barcode);
}

async function syncTickets(fromDate, callback) {
    try {
        log.info('Starting Tickets Update Process...');
        var session = await getDrupalSession();
        log.info('Got Drupal session...');
        var tickets = await dumpDrupalTickets(session, fromDate);
        if (tickets) {
            await updateAllTickets(tickets);
            log.info("Tickets Update Process COMPLETED at", dateFormat(new Date(), "yyyy-mm-dd hh:MM:ss"));
        }
        callback(null);
    }
    catch (err) {
        log.error("ERROR:", err);
        callback(err);
    }
}

function syncTicketsLoop() {
    var timeoutMillis = globalMinutesDelta * 60 * 1000;
    var nextDate = new Date();
    nextDate.setMilliseconds(timeoutMillis);
    log.info("Next ticket sync scheduled to", dateFormat(nextDate, "yyyy-mm-dd hh:MM:ss"));
    setTimeout(() => {
        var now = new Date();
        fromDate = now.setMinutes(-globalMinutesDelta);
        fromDate = now.setSeconds(-10); // A few seconds overlap is always good.
        syncTickets(fromDate, syncTicketsLoop);
    }, timeoutMillis);
}

function runSyncTicketsLoop(minutesDelta) {
    log.info('First run, updating all tickets');
    globalMinutesDelta = minutesDelta;
    var now = new Date();
    const ONE_YEAR_IN_SECONDS = 525948;
    var fromDate = now.setMinutes(-ONE_YEAR_IN_SECONDS);
    syncTickets(fromDate, syncTicketsLoop);
}

module.exports = {
    syncTickets: syncTickets,
    passTicket: passTicket,
    runSyncTicketsLoop: runSyncTicketsLoop
};
