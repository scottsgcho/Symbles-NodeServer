const request = require("tinyreq");
const Promise = require('bluebird');
const parser = require("xml2js").Parser({explicitArray : false});
const cheerio = require('cheerio');
const _ = require('lodash');

const {
    buildQuerystring,
    parseEntry,
    parseReporterTitle,
    parseNonDerivative,
    parseDerivative,
} = require('./helper');
const {
    updateTicker4,
    saveTransaction
} = require('../save');

class scraper {
    constructor() {
        this.cache = [];
        
        this.requestFeed = this.requestFeed.bind(this);
        this.parseEntries = this.parseEntries.bind(this);
        this.parseForm4Url = this.parseForm4Url.bind(this);
        this.parseForm4 = this.parseForm4.bind(this);
        this.filterForm4 = this.filterForm4.bind(this);
        this.checkSignificance = this.checkSignificance.bind(this);
        this.cacheAndSave = this.cacheAndSave.bind(this);
        this.save = this.save.bind(this);
    }

    scrape(options = {}, baseUrl) {
        const queryString = buildQuerystring(options, baseUrl);        
        this.requestFeed(queryString);
    }

    requestFeed(query) {                

        const parseEntries = this.parseEntries;
        request(query, function (err, body) {            
            if (err) {
                console.log('REQUEST FEED ERROR: ', err, '\nURL: ', query);
                return;
            }            
            
            parser.parseString(body, (err, result) => {                
                const entries = result.feed.entry;
                parseEntries(entries);
            });
        });
    }

    //Loop for each of the entries that are returned
    parseEntries(entries) {       
        const parseForm4Url = this.parseForm4Url;
        Promise.map(entries, (entry) => {            
            const parsedEntry = parseEntry(entry);
            return parsedEntry;
        }).map(entry => {               
            if (entry.form === '4' && entry.role === 'Reporting') {                                    
                parseForm4Url(entry);
            }
        });
    }

    parseForm4Url(entry) {            
        const parseForm4 = this.parseForm4;
        request(entry.url, function (err, body) {
            if (err) {
                console.log('PARSE FORM 4 URL ERROR: ', err, '\nURL: ', entry.url);
                return;
            }        
            const $ = cheerio.load(body);
            const xmlLinkKey = $('.blueRow a').first().text();        
            const last = entry.url.split('/').pop(-1);
            const parsedUrl = entry.url.replace(last, xmlLinkKey);        
            parseForm4(parsedUrl, entry);
        });
    }

    parseForm4(url, entry) {   
        const filterForm4 = this.filterForm4;     
        request(url, function (err, body) {
            if (err) {
                console.log('PARSE FORM 4 ERROR: ', err, "\nURL: ", url);
                return;
            }        
            parser.parseString(body, (err, result) => {            
                filterForm4(result, entry);            
            });
        });
    }

    filterForm4(form4, entry) {          
        if (form4 === undefined || form4.ownershipDocument === undefined) {
            console.log('FILTER FORM 4 ERROR: ',form4, '\nURL: ', entry.url);
            return;
        }
        form4 = form4.ownershipDocument;
        const reporter = entry.name;
        const company = form4.issuer.issuerName;
        const ticker = form4.issuer.issuerTradingSymbol;
        const reporterTitle = parseReporterTitle(form4);
        const cik = entry.cik;
        const form4Link = entry.url;
        const accessionNumber = entry.accessionNumber;    
        const derivativeTransaction = parseDerivative(form4);
        const nonDerivativeTransaction = parseNonDerivative(form4);

        const transactionInformation = {        
            ticker, 
            company,         
            reporter,
            reporterTitle,          
            cik,         
            accessionNumber,
            url: form4Link
        };

        const finalValueDer = Object.assign(transactionInformation, derivativeTransaction);
        const finalValueNonDer = Object.assign(transactionInformation, nonDerivativeTransaction);            

        console.log(finalValueDer);

        if (!_.isEmpty(nonDerivativeTransaction) && this.checkSignificance(nonDerivativeTransaction)) {
            finalValueNonDer.transactionAmount = finalValueNonDer.transactionAmount.toFixed(2);
            finalValueNonDer.transactionPrice = finalValueNonDer.transactionPrice.toFixed(2);
            this.cacheAndSave(finalValueNonDer);            
        }
        if (!_.isEmpty(derivativeTransaction) && this.checkSignificance(derivativeTransaction)) {
            finalValueDer.transactionAmount = finalValueDer.transactionAmount.toFixed(2);
            finalValueDer.transactionPrice = finalValueDer.transactionPrice.toFixed(2);    
            this.cacheAndSave(finalValueDer);
        }
    }

    checkSignificance(data) {
        const transactionAmount = Math.abs(data.transactionAmount);
        if (data.transactionCode === 'S') {
            if (transactionAmount > 1000000) {
                return true;
            } else {
                return false;
            }            
        }

        if (data.transactionCode === 'P') {
            if (transactionAmount > 50000) {
                return true;
            } else {
                return false;
            }            
        }

    }

    cacheAndSave(data) {                
        let exists = false;
        for (let i = 0; i < this.cache.length; i++) {
            if (this.cache[i].accessionNumber === data.accessionNumber
            && this.cache[i].cik === data.cik) {  
                exists = true;       
                break;
            }
        }        
        if (!exists) {
            console.log('GOT');
            console.log(data);
            if (this.cache.length >= 100) {
                this.cache.shift();
                this.cache.push(data);
            } else {
                this.cache.push(data);
            }
            this.save(data);            
        }
    }

    save(data) {        
        saveTransaction(data);
        const ticker = {
            ticker: data.ticker,
            company: data.company,
            updated4: data.date
        };
        updateTicker4(ticker);                
    }
}

module.exports = scraper;
