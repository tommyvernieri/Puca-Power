// ==UserScript==
// @name            Puca Power
// @version         1.4.2
// @namespace       https://github.com/llamasoft/Puca-Power
// @supportURL      https://github.com/llamasoft/Puca-Power
// @description     A JavaScript utility for better trading on PucaTrade.com
// @downloadURL     https://llamasoft.github.io/Puca-Power/pucaPower.js
// @grant           unsafeWindow
// @include         https://pucatrade.com/trades
// @include         https://pucatrade.com/trades/
// @run-at          document-idle
// ==/UserScript==

var pucaPower = {

    /* ===== INTERNAL VARIABLES ===== */

    version: 'v1.4.2',
    updateDate: '2016-03-07',

    formUrl: 'https://llamasoft.github.io/Puca-Power/controls.html',

    // Default values for internal settings
    // If you change this structure, you need to update the following:
    //   loadDefaultSettings
    //   applySettingsToPage
    //   loadSettingsFromPage
    //   setupListeners
    //   controls.html
    defaults: {
        // Reload the trade table after reloadInterval seconds since the last reload
        // NOTE: This may be different than "reload every reloadInterval seconds" because
        //   there are actions that reload the table that are beyond our control
        //   (e.g. sending a card, changing country filters, searching for a card)
        reloadInterval: 60,
        maxPages: 10,

        alert: {
            onBundle: true,
            bundleThreshold: 500,
            colorizeBundleRows: true,
            colorizeBundleColor: '#CCFF99',

            onOutgoing: true,
            colorizeOutgoingRows: true,
            colorizeOutgoingColor: '#FFEBB5',

            onNewOnly: false,

            playSound: true,
            soundFile: 'https://llamasoft.github.io/Puca-Power/alert.mp3',

            titleText: '\u2605 Trade alert! \u2605',

            showNotification: true,
            notificationTimeout: 7.5 * 1000
        },

        filter: {
            cardsByValue: false,
            cardsMinValue: 50,
            membersByPoints: false,
            membersMinPoints: 400
        }
    },

    // Settings structures
    reloadInterval: null,
    maxPages: null,
    alert: null,
    filter: null,

    // Selector string to pull the trade table rows
    tableStr: 'table.infinite tbody',
    tableRowStr: 'table.infinite tbody tr[id^="uc_"]',

    // Map of asynchronous events that we may need to wait on
    events: {
        tableLoadComplete: false,
        outgoingLoadComplete: false
    },

    // Array of objects of the loaded trade data
    // Each entry is {tradeID, memberID, memberName, memberPts, country, cardName, cardPts}
    tableData: [],

    // Object of card information
    // Each entry is {cardSet, cardName, cardPts}, key is trade ID
    cardData: {},

    // Object of objects of the table data grouped by memberID
    // Each object has:
    //   memberName - The displayed name of the member
    //   memberPts - The number of points the user has available
    //   country - The country associated with the member
    //   cardQty - The number of cards the user wants from you
    //   tradeIDs - The trade IDs and values associated with the cards they want
    //   totalCardPts - The sum value of all the cards the user wants from you
    //   hasAlert - A flag that's true if the user has some kind of alert (see below)
    //   hasBundleAlert - Flag the notes if the member qualifies as a trade bundle
    //   hasOutgoingAlert - Flag that notes if the member has unsent outgoing trades
    memberData: {},

    // Object of objects of the outgoing (unshipped) trades
    // Each object is {memberName, cardQty, totalCardPts}, key is memberID
    outgoingTrades: {},

    // Object of trade IDs and trade value, key is trade ID
    seenAlerts: {},
    sentTrades: 0,

    // Enable debug messages
    // debugLevel  0 - Errors and trade alerts
    // debugLevel  1 - Important messages only
    // debugLevel  2 - Semi-important messages
    // debugLevel  3 - Informational messages
    // debugLevel >3 - Probably noise
    debugLevel: 0,
    debug: function (msgLevel, msg) {
        var padding;

        if ( msgLevel <= this.debugLevel ) {
            // String.prototype.repeat is proposed, but not always supported
            padding = new Array( Math.min(msgLevel, 10) + 1 ).join('  ');

            console.log(padding + '[' + msgLevel + '] - ' + msg);
        }
    },



    /* ===== SETTINGS FUNCTIONS ===== */

    // Reset all settings to default values
    // Calls applySettingsToPage()
    loadDefaultSettings: function () {
        this.debug(2, 'Resetting settings to default values');

        this.reloadInterval = this.defaults.reloadInterval;
        this.maxPages = this.defaults.maxPages;
        this.alert  = this.defaults.alert;
        this.filter = this.defaults.filter;

        this.applySettingsToPage();
    },


    // Clear local storage settings
    clearLocalSettings: function () {
        this.debug(2, 'Deleting local settings');
        delete localStorage.pucaPowerSettings;
    },

    // Save current settings to local storage
    saveSettingsToLocal: function () {
        if ( typeof Storage === 'undefined' ) {
            this.debug(2, 'No local storage, cannot save settings');
            this.addNote('Your settings were applied but could not be saved locally', 'text-warning');
            return;
        }

        this.debug(2, 'Saving settings to local storage');

        localStorage.pucaPowerSettings = JSON.stringify({
            version:        this.version,
            reloadInterval: this.reloadInterval,
            maxPages:   this.maxPages,
            alert:      this.alert,
            filter:     this.filter,
            debugLevel: this.debugLevel
        });

        this.addNote('Your settings were saved and applied', 'text-success');
    },

    // Load settings from local storage
    // Calls clearLocalSettings() on error
    loadSettingsFromLocal: function () {
        if ( typeof Storage === 'undefined' ) {
            this.debug(2, 'No local storage, cannot load settings');
            return;
        }

        if ( !localStorage.pucaPowerSettings ) {
            this.debug(2, 'No local settings found, skipping load');
            return;
        }

        this.debug(3, 'Loading settings from local storage');
        var settings = JSON.parse(localStorage.pucaPowerSettings);

        if ( !settings ) {
            this.debug(1, 'Failed to parse settings, purging settings');
            this.clearLocalSettings();
            return;
        }


        // Using the default settings as a starting point, overlay the settings we could load
        // This is endended from a new object to prevent clobbering of the defaults object
        settings = $.extend(true, {}, this.defaults, settings);

        this.reloadInterval = settings.reloadInterval;
        this.maxPages   = settings.maxPages;
        this.alert      = settings.alert;
        this.filter     = settings.filter;
        this.debugLevel = settings.debugLevel;
    },


    // Load settings from controls on the page
    // Implicitly calls applySettingsToPage()
    loadSettingsFromPage: function () {
        this.debug(4, 'Loading settings from page');

        var safeParse = function (value, nanFallback, negFallback) {
            var temp = parseInt(value, 10);
            if ( isNaN(temp) ) { temp = nanFallback; }
            if ( temp <= 0 )   { temp = negFallback; }
            return temp;
        };

        this.reloadInterval = safeParse(
            $('input#reloadInterval').val(),
            this.reloadInterval,
            this.defaults.reloadInterval
        );

        // Don't be a menace
        if ( this.reloadInterval < 20 ) { this.reloadInterval = 20; }

        // TODO: maxPages

        this.alert = {
            onBundle: $('input#alertOnBundle').prop('checked'),
            bundleThreshold:
                safeParse(
                    $('input#alertBundleThreshold').val(),
                    this.alert.bundleThreshold,
                    this.defaults.alert.bundleThreshold
                ),
            colorizeBundleRows: $('input#alertColorizeBundleRows').prop('checked'),
            colorizeBundleColor: $('input#alertColorizeBundleColor').val(),

            onOutgoing: $('input#alertOnOutgoing').prop('checked'),
            colorizeOutgoingRows: $('input#alertColorizeOutgoingRows').prop('checked'),
            colorizeOutgoingColor: $('input#alertColorizeOutgoingColor').val(),

            playSound: $('input#alertPlaySound').prop('checked'),
            soundFile: $('input#alertSoundFile').val().trim(),

            onNewOnly: $('input#alertOnNewOnly').prop('checked'),

            titleText: this.defaults.alert.titleText,

            showNotification: $('input#alertShowNotification').prop('checked'),
            notificationTimeout: this.defaults.alert.notificationTimeout
        };

        this.filter = {
            cardsByValue: $('input#filterCardsByValue').prop('checked'),
            cardsMinValue:
                safeParse(
                    $('input#filterCardsMinValue').val(),
                    this.filter.cardsMinValue,
                    this.defaults.filter.cardsMinValue
                ),
            membersByPoints: $('input#filterMembersByPoints').prop('checked'),
            membersMinPoints:
                safeParse(
                    $('input#filterMembersMinPoints').val(),
                    this.filter.membersMinPoints,
                    this.defaults.filter.membersMinPoints
                )
        };

        // In case safeParse() changed anything
        this.applySettingsToPage();
    },

    // Update HTML inputs to match current settings
    // Calls updatePageState() on completion
    applySettingsToPage: function () {
        this.debug(4, 'Applying active settings to page');

        $('input#reloadInterval').val(this.reloadInterval);
        // TODO: maxPages

        // Trade bundle settings
        $('input#alertOnBundle').prop('checked', this.alert.onBundle);
        $('input#alertBundleThreshold').val(this.alert.bundleThreshold);
        $('input#alertColorizeBundleRows').prop('checked', this.alert.colorizeBundleRows);
        $('input#alertColorizeBundleColor').val(this.alert.colorizeBundleColor);

        // Outgoing trades settings
        $('input#alertOnOutgoing').prop('checked', this.alert.onOutgoing);
        $('input#alertColorizeOutgoingRows').prop('checked', this.alert.colorizeOutgoingRows);
        $('input#alertColorizeOutgoingColor').val(this.alert.colorizeOutgoingColor);

        // Alert settings
        $('input#alertPlaySound').prop('checked', this.alert.playSound);
        $('audio#alertSound').attr('src', this.alert.soundFile);
        $('input#alertSoundFile').val(this.alert.soundFile);
        $('input#alertShowNotification').prop('checked', this.alert.showNotification);
        $('input#alertOnNewOnly').prop('checked', this.alert.onNewOnly);

        // Filter settings
        $('input#filterCardsByValue').prop('checked', this.filter.cardsByValue);
        $('input#filterCardsMinValue').val(this.filter.cardsMinValue);
        $('input#filterMembersByPoints').prop('checked', this.filter.membersByPoints);
        $('input#filterMembersMinPoints').val(this.filter.membersMinPoints);


        this.updatePageState();
    },

    // Enable or disable inputs based on current options
    // Called from applySettingsToPage()
    updatePageState: function () {
        var isChecked;
        var isEnabled;

        // Alert on bundle checkbox is connected to its colorize checkboxes
        isChecked = $('input#alertOnBundle').prop('checked');
        $('input#alertBundleThreshold').prop('disabled', !isChecked);
        $('input#alertColorizeBundleRows').prop('disabled', !isChecked);
        $('input#alertColorizeBundleColor').prop('disabled', !isChecked);

        // Colorize bundle rows checkbox is connected to the color picker
        isChecked =  $('input#alertColorizeBundleRows').prop('checked');
        isEnabled = !$('input#alertColorizeBundleRows').prop('disabled');
        $('input#alertColorizeBundleColor').prop('disabled', !(isEnabled && isChecked));


        // Alert on outgoing trades checkbox is connected to its colorize checkboxes
        isChecked = $('input#alertOnOutgoing').prop('checked');
        $('input#alertColorizeOutgoingRows').prop('disabled', !isChecked);
        $('input#alertColorizeOutgoingColor').prop('disabled', !isChecked);

        // Colorize outgoing rows checkbox is connected to the color picker
        isChecked =  $('input#alertColorizeOutgoingRows').prop('checked');
        isEnabled = !$('input#alertColorizeOutgoingRows').prop('disabled');
        $('input#alertColorizeOutgoingColor').prop('disabled', !(isEnabled && isChecked));


        // The play alert sound checkbox is connected to the sound file input
        isChecked = $('input#alertPlaySound').prop('checked');
        $('input#alertSoundFile').prop('disabled', !isChecked);


        // The card value filter checkbox is connected to the minimum card value input
        isChecked = $('input#filterCardsByValue').prop('checked');
        $('input#filterCardsMinValue').prop('disabled', !isChecked);

        // The member filter checkbox is connected to the minimum member points input
        isChecked = $('input#filterMembersByPoints').prop('checked');
        $('input#filterMembersMinPoints').prop('disabled', !isChecked);
    },



    /* ===== TABLE PARSING FUNCTIONS ===== */

    // Load the trade table data into manageable structures (tableData and memberData)
    // This is usually called after loadTableData() completes
    parseTradeTable: function () {
        // Don't bother parsing the data if auto-match is turned off
        if ( !$('input.niceToggle.intersect').prop('checked') ) {
            this.debug(2, 'Skipping trade table parse, auto-match is off');
            return;
        }

        this.debug(2, 'Parsing trade table data');

        this.tableData = [];
        this.cardData = {};
        this.memberData = {};

        // Parse all rows, hidden or not (scrolling may have added more entries)
        var tableRows = $(this.tableRowStr);

        var i;
        var tradeID;
        var curRow, curFields;
        var cardSet, cardName, cardPts;
        var memberID, memberName, memberPts;
        var country;

        // For each row in the trade table
        for (i = 0; i < tableRows.length; i++) {
            curRow = $(tableRows).eq(i);
            curFields = $(curRow).find('td');

            // Extract the relevant table fields
            tradeID  = $(curRow).attr('id');
            cardSet  = $(curFields).eq(0).find('div.hidden').text().trim();
            cardName = $(curFields).eq(1).text().trim();
            cardPts  = parseInt( $(curFields).eq(2).text(), 10 );

            // The member field can have multiple <a> elements, but the last one is always the profile link
            // The other <a> elements are usually the membership level and upgrade link
            // The past part of the profile URL is the member ID; it is unique, memberName isn't
            memberID   = $(curFields).eq(4).find('a').last().attr('href').split('/').pop();
            memberName = $(curFields).eq(4).text().trim();
            memberPts  = parseInt( $(curFields).eq(5).text(), 10 );

            // Pulling from curRow, not curFields because the country column position
            //   depends on membership level as rare-level users have an extra column
            country = $(curRow).find('i.flag').attr('title').trim();


            // Make sure that this row isn't a duplicate
            if ( tradeID in this.cardData ) {
                this.debug(3, 'Duplicate tradeID (' + tradeID + ') removed');
                $(curRow).remove();
                continue;
            }

            // Data per row
            this.tableData.push({
                tradeID:    tradeID,
                memberID:   memberID,
                memberName: memberName,
                memberPts:  memberPts,
                country:    country,
                cardName:   cardName,
                cardPts:    cardPts
            });

            // Data per card
            this.cardData[tradeID] = {
                cardSet:  cardSet,
                cardName: cardName,
                cardPts:  cardPts
            };

            // Data per member
            if ( !(memberID in this.memberData) ) {
                // Make a new entry
                this.memberData[memberID] = {
                    memberName: memberName,
                    memberPts: memberPts,
                    country: country,
                    cardQty: 0,
                    tradeIDs: {},
                    totalCardPts: 0,
                    hasAlert: false,
                    hasBundleAlert: false,
                    hasOutgoingAlert: false
                };

            }

            // Now that we're certain the entry exists, update the data
            this.memberData[memberID].cardQty++;
            this.memberData[memberID].totalCardPts += cardPts;
            this.memberData[memberID].tradeIDs[tradeID] = cardPts;
        }
    },


    // Loads the and parses the outgoing trade information
    //   into a manageable structure (outgoingTrades)
    lastOutgoingLoad: 0,
    loadOutgoingTrades: function (force) {
        this.debug(2, 'Fetching outgoing trades');

        // Skip if not forced and it's been less than 2 minutes since last run
        if ( !force && Date.now() - this.lastOutgoingLoad < 2 * 60 * 1000 ) { return; }


        this.events.outgoingLoadComplete = false;
        this.lastOutgoingLoad = Date.now();


        // Initiate an AJAX request to get the outgoing trades
        // When it returns, parse the outgoing trades table then
        //   call reloadComplete() to parse/filter trades
        $.get('/trades/active', function (data) {
            this.debug(3, 'Got outgoing trades');

            var i;
            var tableRows = $(data).find('table.datatable tbody tr[id^="user_card"]:contains("Unshipped")');
            var curRow, curFields;

            var memberID, memberName;
            var cardPts;

            this.outgoingTrades = {};


            // Gold membership adds columns to the Active Trades page, so we need to get our column index for the receiver manually
            // We do this in two steps because the entire table doesn't exist if the user has no outgoing trades
            // If the table doesn't exist, the 0th index is undefined; undefined.cellIndex is an error
            var memberColumnIndex = $(data).find('table.datatable thead tr th:contains("Receiver")')[0];
            if ( typeof memberColumnIndex !== 'undefined' ) {
                memberColumnIndex = memberColumnIndex.cellIndex;
            }

            // For each row of unshipped trades
            for (i = 0; i < tableRows.length; i++) {
                curRow = $(tableRows).eq(i);
                curFields = $(curRow).find('td');

                cardPts = parseInt( $(curFields).eq(3).text(), 10 );

                // Some member entries can become bugged and somehow lack a profile link
                // We don't care why they're bugged, but trying to parse them would be dumb
                if ( $(curFields).eq(memberColumnIndex).find('a.trader').length < 1 ) {
                    this.debug(0, 'Warning: bugged outgoing trade detected, html = ' + $(curFields).html().replace(/\s+/g, ' '));
                    this.debug(0, 'Table headings html = ' + $(data).find('table.datatable thead').html().replace(/\s+/g, ' '));
                    this.debug(0, 'Using memberColumnIndex of ' + memberColumnIndex);
                    continue;
                }

                memberID = $(curFields).eq(memberColumnIndex).find('a.trader').attr('href').split('/').pop();

                // Thank you StackOverflow! http://stackoverflow.com/a/8851526/477563
                memberName = $(curFields).eq(memberColumnIndex).find('a.trader')
                             .children().remove().end().text().trim();

                if ( !this.outgoingTrades[memberID] ) {
                    this.outgoingTrades[memberID] = {
                        memberName: memberName,
                        cardQty: 1,
                        totalCardPts: cardPts
                    };

                } else {
                    this.outgoingTrades[memberID].cardQty++;
                    this.outgoingTrades[memberID].totalCardPts += cardPts;
                }
            }

            this.events.outgoingLoadComplete = true;
            this.reloadComplete();
        }.bind(this));
    },



    /* ===== ALERT/NOTIFICATION FUNCTIONS ===== */

    clearAllNotes: function () {
        $('li.noteItem:not(#defaultNote)').remove();
        $('li#defaultNote').show();
    },

    getNotes: function () {
        return $('li.noteItem');
    },

    addNote: function (alertText, alertClass) {
        this.debug(4, 'Adding note: ' + alertText);

        $('li#defaultNote').hide();
        $('ul#noteList').append( $('<li class="noteItem">').html(alertText).addClass(alertClass) );
    },

    titleAlertTimeout: null,
    setTitleAlert: function (msg, delay) {
        if ( this.titleAlertTimeout ) { return; }
        if ( typeof delay === 'undefined' ) { delay = 5000; }

        this.origTitle = document.title;
        document.title = msg;

        this.titleAlertTimeout = setTimeout(this.removeTitleAlert.bind(this), delay);
    },

    removeTitleAlert: function () {
        this.titleAlertTimeout = null;
        document.title = this.origTitle;
    },

    hasPlayedSound: true,
    playAlertSound: function () {
        if ( this.alert.playSound && !this.hasPlayedSound ) {
            $('audio#alertSound').trigger('play');
            this.hasPlayedSound = true;
        }
    },

    hasShownNotification: true,
    showNotification: function(msg, timeout) {
        if ( this.alert.showNotification  && !this.hasShownNotification ) {
            if ('Notification' in window && Notification.permission ) {
                var note = new Notification(msg, { icon: 'https://pucatrade.com/favicon.ico' });
                setTimeout(function() { note.close() }, timeout);
                note.addEventListener('click', function() {
                    window.focus();
                    note.close();
                });
            }
            this.hasShownNotification = true;
        }
    },

    // Checks all pending trades for alerts based on user settings
    prevAlerts: {},
    isFirstAlertCheck: true,
    checkForAlerts: function () {
        this.debug(2, 'Checking for alerts');

        var i;
        var pendingAlerts = [];
        var curAlert = {}; // { msg, style, value, memberID }
        var newAlertQty = 0;

        var memberID, memberName, memberPts, memberCountry;
        var tradeIDs, firstTradeID, cardQty, totalCardPts, tradeValue;

        var rowColor;


        // First iterate the individual members by ID
        for ( i in this.memberData ) {
            if ( !this.memberData.hasOwnProperty(i) ) { continue; }

            memberID     = i;
            memberName   = this.memberData[i].memberName;
            memberPts    = this.memberData[i].memberPts;
            memberCountry = this.memberData[i].country;
            tradeIDs     = this.memberData[i].tradeIDs;
            firstTradeID = Object.keys(tradeIDs).shift();
            cardQty      = this.memberData[i].cardQty;
            totalCardPts = this.memberData[i].totalCardPts;

            // If the total card value is under the alert threshold
            //   or the member can afford all cards they want, trust the total value
            // Calling getBestBundle is expensive, so it should only be used sparingly
            if ( totalCardPts < this.alert.bundleThreshold || totalCardPts < memberPts ) {
                tradeValue = totalCardPts;

            } else {
                // It's possible that the member cannot afford all the cards they want
                // Find the largest bundle of trades the member can actually afford
                tradeValue = this.getBestBundle(tradeIDs, memberPts).value;

                if ( tradeValue < this.alert.bundleThreshold ) {
                    this.debug(2, memberName + ' (' + memberID + ') cannot afford ' + this.alert.bundleThreshold);
                }
            }


            curAlert = {
                memberID: memberID,
                style: (totalCardPts > memberPts ? 'text-warning' : ''),
                value: tradeValue,
                isNew: false
            };

            curAlert.isNew = false;
            // Did we see this member last check?
            if ( memberID in this.prevAlerts ) {

                // Yes, but do they want anything new?
                for ( tradeID in tradeIDs ) {
                    if ( !(tradeID in this.prevAlerts[memberID]) ) {
                        curAlert.isNew = true;
                        break;
                    }
                }

            } else {
                // This member wasn't in our last alerts, that means they're new
                curAlert.isNew = true;
            }

            var alertStar = (
                ( curAlert.isNew && !this.isFirstAlertCheck )
                ? '<abbr title="this alert is new or has added new cards">&#9733;</abbr>'
                : ''
            );


            // Note: the last alert a member qualifies for takes priority
            // Does this qualify as a bundle alert?
            if ( this.alert.onBundle && tradeValue >= this.alert.bundleThreshold ) {
                this.memberData[i].hasAlert = true;
                this.memberData[i].hasBundleAlert = true;

                // Queue the alert
                // If the trade value is limited by the user's points, mark the entry
                // If this trade is new/changed, mark the entry with a star (except on first load)
                curAlert.msg =
                    '<span onclick="pucaPower.snapTo(\'#' + firstTradeID + '\');">'
                  + '<strong>' + memberName + '</strong> '
                  + 'wants ' + cardQty + ' cards for '
                  + '<strong class="' + curAlert.style + '">' + totalCardPts + ' points</strong> '
                  + alertStar
                  + '(' + memberCountry + ')'
                  + '</span>'
                ;
            }


            // Does this member have outgoing trades?
            if ( this.alert.onOutgoing && memberID in this.outgoingTrades ) {
                this.memberData[i].hasAlert = true;
                this.memberData[i].hasOutgoingAlert = true;

                // The value is increased by how much we're already sending them
                curAlert.value += this.outgoingTrades[memberID].totalCardPts;

                curAlert.msg =
                    '<span onclick="pucaPower.snapTo(\'#' + firstTradeID + '\');">'
                  + '<strong>' + memberName + '</strong> '
                  + 'has outgoing trades and wants ' + cardQty + ' more cards for '
                  + '<strong>' + totalCardPts + ' points</strong> ' + alertStar
                  + '</span>'
                ;
            }


            if ( typeof curAlert.msg !== 'undefined' ) {
                pendingAlerts.push(curAlert);
                newAlertQty += curAlert.isNew;
            }
        }


        // Iterate the table elements and colorize alerts
        for (i = 0; i < this.tableData.length; i++) {
            memberID     = this.tableData[i].memberID;
            memberPts    = this.memberData[memberID].memberPts;
            totalCardPts = this.memberData[memberID].totalCardPts;
            rowColor = null;

            if ( this.memberData[memberID].hasAlert ) {
                this.seenAlerts[ this.tableData[i].tradeID ] = this.tableData[i].cardPts;


                // Colorize if part of a bundle
                if ( this.alert.colorizeBundleRows && this.memberData[memberID].hasBundleAlert ) {
                    rowColor = this.alert.colorizeBundleColor;
                }

                // Colorize if has outgoing trades (will override bundle)
                if ( this.alert.colorizeOutgoingRows && this.memberData[memberID].hasOutgoingAlert ) {
                    rowColor = this.alert.colorizeOutgoingColor;
                }

                // If we have a pending color, apply it
                if ( rowColor !== null ) {
                    $('#'+ this.tableData[i].tradeID).find('td').css('background-color', rowColor);
                }


                // Put a mark next to the member's points if they can't afford all the cards they want
                if ( memberPts < totalCardPts ) {
                    if ( !$('#'+ this.tableData[i].tradeID).data('hasPointWarning') ) {
                        $('#'+ this.tableData[i].tradeID).data('hasPointWarning', true);
                        $('#'+ this.tableData[i].tradeID).find('td.points').prepend('<i class="icon-warning-sign"></i>&nbsp;&nbsp;');
                        $('#'+ this.tableData[i].tradeID).find('td.points').append('&nbsp;&nbsp;<i class="icon-warning-sign"></i>');
                    }
                }
            }
        }


        if ( pendingAlerts.length > 0 ) {
            if ( !this.alert.onNewOnly || (this.alert.onNewOnly && newAlertQty > 0) ) {
                this.playAlertSound();
                this.setTitleAlert(this.alert.titleText);
                this.showNotification(this.alert.titleText, this.alert.notificationTimeout);
            }

            window._gaq.push(['pucaPowerGA._trackEvent', 'PucaPower', 'Alert']);
        }


        // Sort new alerts to the top (isNew descending), then alerts by value (value descending)
        pendingAlerts.sort(function (a, b) { return (b.isNew - a.isNew) || (b.value - a.value); });

        // Display the alerts, highest value first
        // Update the prevAlert structure for next alert check
        this.prevAlerts = {};
        for (i = 0; i < pendingAlerts.length; i++) {
            curAlert = pendingAlerts[i];
            this.debug(0, $(curAlert.msg).text());
            this.addNote(curAlert.msg);

            this.prevAlerts[curAlert.memberID] = this.memberData[curAlert.memberID].tradeIDs;
        }

        this.debug(1, 'Found ' + pendingAlerts.length + ' alerts, ' + newAlertQty + ' new or expanded');

        this.isFirstAlertCheck = false;
    },



    /* ===== MISC/UTILITY FUNCTIONS ===== */

    donationRequest: function () {
        // If a donation request already exists, don't make another
        if ( $('li.donationRequest').length > 0 ) { return; }

        var paypal    = '<a href="https://www.paypal.com/cgi-bin/webscr?cmd=_s-xclick&hosted_button_id=5GF3TD343BS4A">PayPal</a>';
        var bitcoin   = '<a href="https://www.coinbase.com/checkouts/630f3600438a42cce9fc9aba8b23f744">Bitcoin</a>';
        var pucatrade = '<a href="https://pucatrade.com/profiles/show/59386">Puca Trade</a>';


        if ( this.sentTrades > 0 ) {
            this.addNote('Puca Power has helped you send <strong>' + this.sentTrades + ' trades</strong> this session.');
        }

        // The sum of all unique alerted trades
        var alertPoints = Object.keys(this.seenAlerts).reduce(function (sum, cur) { return sum + this.seenAlerts[cur]; }.bind(this), 0);
        if ( alertPoints > 0 ) {
            this.addNote('Puca Power has alerted you to <strong>' + alertPoints + ' points</strong> in trades this session.');
        }

        this.addNote(
            '<strong>Do you like Puca Power?</strong> <i class="icon-heart"></i> '
          + 'Consider donating via ' + paypal + ', ' + bitcoin + ', or ' + pucatrade + '!',
            'donationRequest'
        );
    },

    news: function () {
        // Only display news for up to two weeks
        if ( Date.now() - new Date(this.updateDate).getTime() <= 14 * 24 * 60 * 60 * 1000 ) {
            this.addNote('Version ' + this.version + ' released on ' + this.updateDate + '! See the change log for full details.', 'text-success');
        }
    },

    // Returns the maximal combination of trades (a bundle) that doesn't exceed memberPts
    // If targetValue is specified, return the first bundle that meets or exceeds it
    getBestBundle: function (trades, memberPts, targetValue) {
        // { combinedValue: { itemID: value, ... }, ... }
        // Indexing by the combined trade value helps greatly reduce the search space
        // Because we only care about the maximum bundle value, we don't care about
        //   two different bundles of trades that yield the same total value
        // i.e. {A: 10, B: 20} is just as good as {C: 15, D: 15}, so only track one
        // The only preference we make is that fewer trades is better
        var bundles = { 0: {} };
        var bestBundleValue = 0;

        // For each trade the member wants...
        for ( var curTradeID in trades ) {
            var curTradeValue = parseInt(trades[curTradeID], 10);

            // Attempt to add it to all possible trade bundles
            for ( var bundleValue in bundles ) {
                // Skip any bundles that already contain this card
                // This should never happen as we only iterate trades once but better safe than infinite
                if ( curTradeID in bundles[bundleValue] ) { continue; }

                // If the new bundle value exceeds the member's points, skip it
                var newValue = parseInt(bundleValue, 10) + curTradeValue;
                if ( newValue > memberPts ) { continue; }

                // Copy and extend the bundle with our current trade included
                var newBundle = $.extend({}, bundles[bundleValue]);
                newBundle[curTradeID] = curTradeValue;

                // Check if a bundle of this value already exists
                if ( newValue in bundles ) {
                    // A bundle of this value exists
                    var newTradeQty = Object.keys( newBundle ).length;
                    var oldTradeQty = Object.keys( bundles[newValue] ).length;

                    // Only replace it if this bundle has fewer trades
                    if ( newTradeQty < oldTradeQty ) {
                        bundles[newValue] = newBundle;
                        bestBundleValue = newValue;
                    }

                } else {
                    // This is a new bundle value
                    bundles[newValue] = newBundle;

                    if ( newValue > bestBundleValue ) {
                        bestBundleValue = newValue;
                    }
                }
            }

            // Break early if targetValue is set and we currently exceed it
            if ( typeof targetValue !== 'undefined' && bestBundleValue >= targetValue ) { break; }
        }

        return {value: bestBundleValue, tradeIDs: bundles[bestBundleValue]};
    },

    // Enables the auto-match feature of the trade table
    // This is required if we want any of the alerts to be valid
    enableAutoMatch: function () {
        if ( !$('input.niceToggle.intersect').prop('checked') ) {
            this.debug(2, 'Enabling auto-match');
            $('input.niceToggle.intersect').prop('checked', true);
            $('label.niceToggle.intersect').addClass('on');

            // lastVars may or may not be defined yet
            window.lastVars = $.extend({ intersect: true }, window.lastVars);
        }
    },

    // Snaps an element/selector into view
    // If no element/selector is specified, snap to top of current page
    snapTo: function (selector) {
        if ( typeof selector === 'undefined' ) {
            // No selector? Default to top of page
            selector = 'html';

        } else {
            // Push browser history for current selector
            // This allows us to snap to top when we pop this state
            history.pushState({snapTo: selector}, '');
        }


        try {
            // Snap the thing into view, catching an exception if thing doesn't exist
            $('html, body').animate({
                scrollTop: $(selector).first().offset().top
            }, 0);

        } catch (e) {
            this.debug(0, 'Failed to snap ' + selector + ' into view: ' + e);
        }
    },



    /* ===== FILTER FUNCTIONS ===== */

    filterTrades: function () {
        this.debug(2, 'Filtering trades');
        var i;
        var filterQty = 0;
        var memberID, memberName, memberPts, hasAlert;
        var cardName, cardPts;
        var matchedFilter;

        for (i = 0; i < this.tableData.length; i++) {
            memberID   = this.tableData[i].memberID;
            memberName = this.tableData[i].memberName;
            memberPts  = this.memberData[memberID].memberPts;
            hasAlert   = this.memberData[memberID].hasAlert;

            cardName = this.tableData[i].cardName;
            cardPts  = this.tableData[i].cardPts;

            matchedFilter = false;

            // Skip entries that have pending alerts
            if ( hasAlert ) { continue; }


            // Filter cards by value
            if ( this.filter.cardsByValue && cardPts < this.filter.cardsMinValue ) {
                this.debug(5, 'Filtering trade: ' + cardName + ' (' + cardPts + ')');
                matchedFilter = true;

            // Filter members by points
            } else if ( this.filter.membersByPoints && memberPts < this.filter.membersMinPoints ) {
                this.debug(4, 'Filtering member: ' + memberName + ' (' + memberPts + ')');
                matchedFilter = true;
            }


            // If we found at least one filter criteria, remove the trade offer
            if ( matchedFilter ) {
                filterQty++;
                $('#'+ this.tableData[i].tradeID).remove();
            }
        }

        if ( filterQty > 0 ) {
            this.addNote('Filtered ' + filterQty + ' trades', 'muted');
        }

        // Update the "Total" label on the table
        $('p#total').text('Total: ' + (this.tableData.length - filterQty));
    },



    /* === DRIVER FUNCTIONS === */

    // Initiate trade data reload
    // This kicks off the loadTableData() function which
    //   kicks off loadOutgoingTrades() via .ajaxSend hook if necessary
    // Once all the async calls finish, they each attempt
    //   to call reloadComplete() but only the final call succeeds
    running: false,
    go: function () {

        // If a fancybox window is open, stall the reload
        // There's no point reloading the list if the user is currently confirming a trade
        if ( $('.fancybox-inner').length > 0 ) {
            this.debug(3, 'Stalling reload');
            this.reloadTimeout = setTimeout(this.go.bind(this), 1000);
            return;
        }

        this.clearAllNotes();
        this.addNote('Reload started', 'text-success');
        this.debug(1, 'Reloading table data');

        // Reload settings in case something changed
        this.loadSettingsFromPage();

        this.running = true;
        this.reloadTimeout = null;
        this.hasPlayedSound = false;
        this.hasShownNotification = false;

        $('button#start').removeClass('btn-success');
        $('button#start').prop('disabled', true);

        $('button#stop').addClass('btn-danger');
        $('button#stop').prop('disabled', false);

        // Auto-match must be on, otherwise things get weird with alerts and filtering.
        this.enableAutoMatch();

        this.events.tableLoadComplete = false;
        window.loadTableData();
        window._gaq.push(['pucaPowerGA._trackEvent', 'PucaPower', 'Reload']);
    },

    // The trade table finished updating and we can now load the data
    // This can also be triggered by the infinite table adding an extra page
    reloadComplete: function () {
        // We will be called multiple times from the .ajaxComplete handler
        //   but we will only run once (when all of the events are ready)
        if ( !this.events.tableLoadComplete || !this.events.outgoingLoadComplete ) { return; }

        // If we're not running, don't do anything
        if ( !this.running ) { return; }

        this.parseTradeTable();
        this.clearAllNotes();
        this.checkForAlerts();
        this.filterTrades();

        // We don't need these sitting around any more
        if ( this.debugLevel < 3 ) {
            this.tableData  = [];
            this.cardData   = {};
            this.memberData = {};
        }

        // A reload is automatically queued when a vanilla table reload starts,
        //   see .ajaxSend handler in setupListeners()
        this.queueReload();
    },

    // Queues or requeues a table reload
    reloadTimeout: null,
    queueReload: function () {
        // If we're not running, don't queue a reload
        if ( !this.running ) { return; }

        // If a reload is already pending, cancel it so we can reschedule it
        this.cancelReload();

        // If the reloadInterval is sane, queue up a reload
        if ( this.reloadInterval >= 20 ) {
            this.reloadTimeout = setTimeout(this.go.bind(this), this.reloadInterval * 1000);
            this.debug(4, 'Reload queued');
        }
    },

    // Cancels a pending reload
    cancelReload: function () {
        // If a reload is already pending, cancel it so we can reschedule it
        if ( this.reloadTimeout ) {
            clearTimeout(this.reloadTimeout);
            this.reloadTimeout = null;
            this.debug(4, 'Reload canceled');
        }
    },

    // Stop the reload, clear the reload handle
    stop: function () {
        this.debug(1, 'Stopping table reload');

        this.running    = false;
        this.hasAlerted = true;

        $('button#start').addClass('btn-success');
        $('button#start').prop('disabled', false);

        $('button#stop').removeClass('btn-danger');
        $('button#stop').prop('disabled', true);

        // If we have a pending reload, cancel it
        this.cancelReload();
    },



    /* === SETUP FUNCTIONS === */

    // Responsible for setting up event listeners and handlers
    setupListeners: function () {

        // Hook all AJAX requests
        // This lets us detect certain activities and react to them
        $(document).ajaxSend(function (e, xhr, settings) {
            var cardPts = 0;

            // Remove url parameters (after "?"), then remove trailing frontslashes
            var url = settings.url.split('?')[0].replace(/\/+$/, '');
            this.debug(4, '.ajaxSend - ' + url);

            // Suppress fancybox loading animation
            $.fancybox.hideLoading();


            // If we're not running, we don't care about hooking events
            // But hey, at least the fancybox loading animation got suppressed
            if ( !this.running ) { return; }


            // Determine the AJAX request by the URL it's fetching
            if ( url.indexOf('/trades/active') !== -1 ) {
                // This is us loading the outgoing trades
                // No action is required

            } else if ( url.search(/^\/trades\/[A-Za-z_\/]+/) !== -1 ) {
                // This is a call to something under /trades/ that isn't a trade table fetch
                // It could be a card confirmation dialog, a lock release,
                //   or the user committing to send a card

                // If the call is a card confirmation, we need to reload
                //   the outgoing trades at the next available opportunity
                // (Which should be pretty soon, closing the dialog triggers a table reload)
                if ( url.indexOf('/trades/confirm') !== -1 ) {
                    this.debug(3, 'Resetting outgoing trade reload timer, user confirmed a trade');
                    this.lastOutgoingLoad = 0;
                    this.sentTrades++;

                    // Get the card points for analytic purposes
                    cardPts = this.cardData['uc_' + url.split('/').pop()].cardPts || 0;
                    window._gaq.push(['pucaPowerGA._trackEvent', 'PucaPower', 'Send', 'Card Points', cardPts]);
                }

            } else {
                // We've ruled out everything else; this is a trade table fetch
                // It can come in three forms
                //   /trades or /trades/ -> vanilla reload, getting the first page of trades
                //   /trades/[NUM]       -> fetching a specific page of trades

                if ( url.search(/^\/trades\/\d+/) !== -1 ) {
                    // Fetching a specific page of trades
                    // No action required

                } else {
                    // Vanilla reload
                    // Load the outgoing trades if required
                    if ( Date.now() - this.lastOutgoingLoad > 120 * 1000 ) {
                        this.loadOutgoingTrades();
                    }
                }
            }
        }.bind(this));


        // Hook all AJAX completions
        $(document).ajaxComplete(function (e, xhr, settings) {

            // Remove url parameters (after "?"), then remove trailing frontslashes
            var url = settings.url.split('?')[0].replace(/\/+$/, '');
            this.debug(4, '.ajaxComplete - ' + url);

            // If we're not running, we don't need to handle anything
            if ( !this.running ) { return; }

            // Determine the AJAX request by the URL it's fetching
            if ( url.indexOf('/trades/active') !== -1 ) {
                // This is us loading the outgoing trades
                // Handling has been relocated to loadOutgoingTrades()
                // No action is required

            } else if ( url.search(/^\/trades\/[A-Za-z_\/]+/) !== -1 ) {
                // This is a call to something under /trades/ that isn't a trade table fetch
                // It could be a card confirmation dialog, a lock release,
                //   or the user committing to send a card
                // No action is required

            } else {
                // We've ruled out everything else; this is a trade table fetch
                // It can come in three forms
                //   /trades or /trades/ -> vanilla reload, getting the first page of trades
                //   /trades/[NUM]       -> fetching a specific page of trades

                var curPage = $('table.infinite tbody').data().infinitescroll.options.state.currPage;
                var curLoadQty = $(xhr.responseText).find(this.tableRowStr).length;
                this.debug(3, 'Loaded ' + curLoadQty + ' trades');

                // PucaTrade loads a seemingly random number of trades with each trade page (200 to 300)
                // Usually, if the number of loaded trades is over 175, there's another page waiting
                // Start loading the next page and only filter/alert once all pages have been loaded
                // In case something goes wrong, hard cap the trade pages at 15 (about 4.5k trades)
                if ( curLoadQty >= 175 && curPage < this.maxPages ) {
                    if ( $('#tradePageNum').length < 1 ) {
                        this.addNote('Loading page <span id="tradePageNum"></span> of trades...', 'text-success');
                    }

                    $('#tradePageNum').text(curPage + 1);
                    setTimeout(function () { $(this.tableStr).infinitescroll('retrieve'); }.bind(this), 250);

                } else {
                    // We've hit the end of the table loading, now we can start filtering/alerting
                    this.events.tableLoadComplete = true;
                    this.reloadComplete();
                }
            }
        }.bind(this));


        // Button and input listeners to keep the settings form pretty
        $('button#start').click(function () {
            this.go();
        }.bind(this));
        $('button#stop').click(function () {
            this.donationRequest();
            this.addNote('Reload stopped', 'text-warning');
            this.stop();
        }.bind(this));


        $('button#save').click(function () {
            this.loadSettingsFromPage();
            this.saveSettingsToLocal();
        }.bind(this));
        $('button#reset').click(this.loadDefaultSettings.bind(this));

        $('input#alertOnBundle').click(this.updatePageState.bind(this));
        $('input#alertColorizeBundleRows').click(this.updatePageState.bind(this));

        $('input#alertOnOutgoing').click(this.updatePageState.bind(this));
        $('input#alertColorizeOutgoingRows').click(this.updatePageState.bind(this));

        $('input#alertPlaySound').click(this.updatePageState.bind(this));
        $('i#alertPreviewSound').click(function () {
            this.loadSettingsFromPage();
            $('audio#alertSound').trigger('play');
        }.bind(this));

        $('input#alertShowNotification').click(this.loadSettingsFromPage.bind(this));
        $('input#alertOnNewOnly').click(this.loadSettingsFromPage.bind(this));

        $('input#filterCardsByValue').click(this.updatePageState.bind(this));
        $('input#filterMembersByPoints').click(this.updatePageState.bind(this));

        // When the window state is popped, scroll to top
        window.onpopstate = function ( event ) { this.snapTo(); }.bind(this);
    },

    // Responsible for initial loading and setup
    setup: function () {

        // Returns true if search is in the current URL, case insensitive
        // This will only be used within the setup routine
        var inUrl = function ( search ) {
            return (window.location.href.toLowerCase().indexOf(search) !== -1);
        }

        // If we're not on PucaTrade, we shouldn't run
        if ( !inUrl('pucatrade.com') ) {
            alert('Hey!  This doesn\'t look like PucaTrade!');
            return;
        }

        // The trades section is specifically "pucatrade.com/trades" but nothing under it
        // For example: "pucatrade.com/trades" is good, "pucatrade.com/trades/active" is bad
        // Attempting to access "pucatrade.com/trades/" redirects to "pucatrade.com/trades"
        //   so any front slashes after "trades" is a failure
        if ( !inUrl('pucatrade.com/trades') || inUrl('pucatrade.com/trades/') ) {
            alert('Hey!  This isn\'t the Trades section!');
            return;
        }


        // If we're running as a UserScript, migrate to the main page with a <script> tag
        if ( typeof unsafeWindow !== 'undefined' ) {
            this.debug(0, 'Migrating to <script> tag');

            var script = document.createElement('script');
            script.type = 'text/javascript';
            script.src  = 'https://llamasoft.github.io/Puca-Power/pucaPower.js';
            document.body.appendChild(script);

            return;
        }


        // Required styling options
        $('<style id="pucaPowerCSS" type="text/css"></style>').appendTo('head');
        $('style#pucaPowerCSS').append('.noteItem { list-style: disc inside !important; }');
        $('style#pucaPowerCSS').append('.toTop { font-size: 2em; position:fixed; top: 0.1em; right: 0.0em; cursor: default; }');


        // Load the user's settings (if possible)
        this.loadDefaultSettings();
        this.loadSettingsFromLocal();

        // Ask the user for Notification permissions
        if ('Notification' in window) { Notification.requestPermission(); }

        // Disable AJAX caching
        $.ajaxSetup({ cache: false });


        // Make a div to put the controls in
        if ( $('div#pucaPower').length < 1 ) {
            $('div#content-wrapper').prepend('<div id="pucaPower"></div>');
        }

        // Load the settings form by clobbering our div, add timestamp to prevent caching
        $('div#pucaPower').load(this.formUrl + '?' + Date.now(), function () {
            this.debug(1, 'Input form loaded');

            this.applySettingsToPage();

            this.setupListeners();

            $('#pucaPowerVersion').text(this.version);

            $('button#stop').prop('disabled', true);

            this.news();
            this.donationRequest();
        }.bind(this));


        // Always disable the infinite scrolling
        // The reloader now fetches all pages of trades, not just the first,
        //   so there's no need for infinite scrolling while PucaPower is active
        $(this.tableStr).infinitescroll('pause');


        // Setup google analytics
        window._gaq = window._gaq || [];
        window._gaq.push(['pucaPowerGA._setAccount', 'UA-62931323-2']);
        window._gaq.push(['pucaPowerGA._trackPageview', '/trades']);

        (function() {
            var ga = document.createElement('script'); ga.type = 'text/javascript'; ga.async = true;
            ga.src = ('https:' == document.location.protocol ? 'https://ssl' : 'http://www') + '.google-analytics.com/ga.js';
            var s = document.getElementsByTagName('script')[0]; s.parentNode.insertBefore(ga, s);
        })();
    }
};

pucaPower.setup();
