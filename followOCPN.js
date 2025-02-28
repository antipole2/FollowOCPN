// user options
const ports = [60002, 60003];	// The output ports to offer
const navUpdatePeriod = 5;	// navigation data update period in seconds
const courseUpdatePeriod = 10;	// course data update period in seconds
const adviseTime = 7;			// seconds to display notifications.  Set to false to supress
const maxWaypointNameLength = 15;
const maxRouteNameLength = 60;
const uniqueNames = true;		// uniquify routepoint names within route
const sender = "FO";	// NMEA0183 sender ID for generated sentences

// debugging settings
log = false;	// print to output window as well as file
send = true;	// whether to send NMEA output to the ports - normally true
trace = false;

const scriptName = "FollowOCPN";
const scriptVersion = 1.0
require("pluginVersion")("3.1.1");
require("checkForUpdate")(scriptName, scriptVersion, 5, "https://raw.githubusercontent.com/antipole2/followOCPN/main/version.JSON");
consoleName(scriptName);

// Enduring variables in outermost scope
var activeRouteGUID = false;	
var adviseTimer = 0;	// timer id
var previousWaypoint = false;
var lastWaypointGUID = false;
var route;	// The active route with unique routepoint names
var startPoint = false;	// if needed, the prepended start point
var onlyGoto = false;	// true if this a simple Go To 
Position = require("Position");
workingPosition = new Position;

// Look for the output ports
allHandles = OCPNgetActiveDriverHandles();
if (log) print("Handles: ",allHandles, "\n");
handles = [];	// handles to use
portActive = [];
for (h = 0; h < allHandles.length; h++){
	attributes = OCPNgetDriverAttributes(allHandles[h]);
	for (var p = 0; p < ports.length; p++){
		if (attributes.netPort == ports[p]){
			if (attributes.protocol != "nmea0183") throw("Connection ", ports[p], " is not NMEA0183");
			handles.push(allHandles[h]);
			portActive.push(0);
			if (trace) print("Connection ", ports[p], " has handle '", allHandles[h], "\n"); 
			}
		}
	}
if (handles.length < ports.length) throw("Some connections not found");
else if (handles.length > ports.length) throw("Some connectiona not unique");
if (log) {for (h = 0; h < handles.length; h++) print("Handle ", h, " is port ", ports[h], "\n");}

//off we go
consolePark();
onAllSeconds(updateNav, navUpdatePeriod);
onAllSeconds(updateRoute, courseUpdatePeriod);
//OCPNonAllNMEA0183(handleMWV, "MWV");
// that's it - the functions do the rest

function handleMWV(message){
	if (!message.OK) return;	// ignore if bad checksum
	output(message.value);
	return;
	}

function updateNav(){
	navData = OCPNgetNavigation();
	if (trace) printOrange(navData, "\n");
	thisMoment = new Date();
	moment = thisMoment.toTimeString();
	UTC = moment.slice(0,2) + moment.slice(3,5) + moment.slice(6,12);
	sentence = "$" + sender + "GLL," + new Position(navData.position).NMEA + "," + UTC + ",A,A";
	output(sentence);
	for (var h = 0; h < handles.length; h++){
		if (portActive[h] == -1) portActive[h] = 0;
		}
	if (isNaN(navData.variation)) navData.variation = 0;	// if no value, treat as zero
	// if stationary, COG and HDG might not be valid numbers - avoid including them.
	if (!isNaN(navData.COG)){
		sentence = "$" + sender + "VTG," + navData.COG + ",T,,M," + navData.SOG + ",N,,K,A";
		output(sentence);
		}
	if (!isNaN(navData.HDM)){
		sentence = "$" + sender +"HDG," + navData.HDM + ",,," + Math.abs(navData.variation) + "," + ((navData.variation < 0)?"W":"E");
		output(sentence);
		}
	if ((!isNaN(navData.COG)) && (!isNaN(navData.SOG))){
		ddmmyy =
			("00" + (thisMoment.getDate())).slice(-2) +
			("00" + (thisMoment.getMonth()+1)).slice(-2) +
			("00" + thisMoment.getFullYear()).slice(-2);
		sentence = "$" + sender + "RMC," + UTC + ",A," + new Position(navData.position).NMEA + "," +
			navData.SOG + "," + navData.COG + "," + ddmmyy + "," + 
			Math.abs(navData.variation) + "," + ((navData.variation >= 0)?"E":"W") + ",A";
		output(sentence);
		}
	if (trace) printOrange("Ending updateNav\n");
	}

function updateRoute(){
	if (trace) printOrange("Entered updateRoute\t\n");
	activeWaypointGUID = OCPNgetActiveWaypointGUID();
	if (!activeWaypointGUID){	//  No active waypoint
		if (activeRouteGUID){	// Route has been deactivated
			advise("Route deactivated");
			if (trace) printOrange("Route deactivated");
			}
		deactivate();	// make sure everything is reset
		return;
		}
	if (activeRouteGUID && (route.GUID != activeRouteGUID)){
		if (trace) printOrange("Switching active route\n");
		advise("Route deactivated");
		deactivate();	// clear out previou stuff
		}
	route = OCPNgetRoute(OCPNgetActiveRouteGUID());	// Get the active route
	if (route.name == "") route.name = "undefined";	// avoid empty route name

	if (!activeRouteGUID) { // route has just been activated
		if (trace) printOrange("Activating route '", route.name, "'\n");
//printBlue(route, "\n", route.name, "\t", route.waypoints.length, "\n");
		if (((route.name == "Temporary GOTO Route") || (route.name =="Go to Dropped mark")) && (route.waypoints.length == 2))onlyGoto = true; 
		// need to find previous mark for RMB/BOD purposes
		var p;
		for (p = 0; p < route.waypoints.length; p++){
			if (route.waypoints[p].GUID == activeWaypointGUID) {
				if (trace) printOrange("Found activeWaypointGUID in route at point ", p, "\n");
				if (p == 0){	// was first in route, so prep[end sometthing
//					navData = OCPNgetNavigation();
					startPoint = {position: OCPNgetNavigation().position, markName:"Start", GUID: 0};	// notional waypoint where we are - startPoint gets remembered
					if (trace) printOrange("Adding start point ", startPoint, "\n");
					previousWaypoint = startPoint;
					route.waypoints.unshift(previousWaypoint);	// add to front of route
					}
				else previousWaypoint = route.waypoints[p-1];
				break;
				}
			}
		if ( p >= route.waypoints.length) throw("Logic error 1 in updateRoute");
		activeRouteGUID = route.GUID;		
		advise("Activating route  '" + route.name + "'");	
		}
	else {	// a route already active
		if (route.GUID != activeRouteGUID) {	// user has switched route without deactivating
			advise("Route switched");
			deactivate();	// clear out previous stuff
			updateRoute();	// start over again - this recursive!
			return;
			}
		if (startPoint) route.waypoints.unshift(startPoint);	// restore the extra start point
		if (lastWaypointGUID != activeWaypointGUID){	// route has been advanced
			if (trace) printOrange("Routepoint advanced\n");
			previousWaypoint = OCPNgetSingleWaypoint(lastWaypointGUID);
			advise("Activated next mark");
			}
		}
	lastWaypointGUID = activeWaypointGUID;
	activeRouteGUID = OCPNgetActiveRouteGUID();
	if (!activeRouteGUID){	// should not be, but let's be defensive
		if (trace) printRed("Not found active route\n");
		deactivate();
		advise("Route deactivated");
		return;
		}

	// target platform may be limited in characters and length of route and waypoint names
	route.name = clean(route.name, maxRouteNameLength);
	for (var p = 0; p < route.waypoints.length; p++) route.waypoints[p].markName = clean(route.waypoints[p].markName, maxWaypointNameLength);
	if (uniqueNames) makeRoutePointsUnique(route);
	sendRoute(route);
	OCPNonActiveLeg();	// cancel any outstanding
	OCPNonActiveLeg(sendRMB);
	if (trace) printOrange("Ending updateCourse\n");
	}

function sendRMB(leg){
	if (trace) printOrange("Starting in sendRMB\n");
	activeWaypointGUID = OCPNgetActiveWaypointGUID();
	if (!activeWaypointGUID) return;	// cannot start yet
	activeWaypoint = OCPNgetSingleWaypoint(activeWaypointGUID);
	var activePointIndex;
	var points = route.waypoints;
	for (activePointIndex = 0; activePointIndex < points.length; activePointIndex++){
		if (points[activePointIndex].GUID == activeWaypointGUID) break;
		}
	if ((activePointIndex == 0) ||(activePointIndex >= points.length)){
		// unlikely but possible if switching routes in middle of route
		deactivate();	// start over
		advise("Confused - route deactivated");
		return;
		}
	xte = leg.xte;
	var navData = OCPNgetNavigation();
	angle = navData.COG - leg.bearing;
	if (angle < 0) angle += 360;
	toName = route.waypoints[activePointIndex].markName;	// NB Cannot se name from leg as we may have uniquified it
	fromName = route.waypoints[activePointIndex-1].markName;
	closing = navData.SOG*Math.cos(angle * Math.PI/180);	// closing speed - degrees to radian for cos
	sentence = "$" + sender + "RMB,A," + Math.abs(xte).toFixed(2) + "," + ((xte >= 0)?"L":"R" ) + "," +
		fromName + "," + toName + "," + (new Position(activeWaypoint.position)).NMEA + "," +
		leg.distance.toFixed(2) + "," + leg.bearing.toFixed(1) + "," + closing.toFixed(2) + "," + (leg.arrived?"A":"V");
	output(sentence);
	if (!onlyGoto){	// This not needed if only a goto
		// now the BOD - origin to destination
		sentence = "$" + sender + "BOD," + leg.bearing.toFixed(2) + ",T," + leg.bearing.toFixed(2) + ",M," + toName + "," + fromName;
		output(sentence);
		if (trace) printOrange("Done in sendRMB\n");
		}
	}
	
function sendRoute(route){	// sends out WPT and RTL sentences
	// we work through the route points, sending out WPL sentences and noting which is the next and last
	if (trace) printOrange("Route: ", route, "\n");
	for (var i = 0; i < route.waypoints.length; i++){// push out the WPT sentences
		workingPosition.latitude = route.waypoints[i].position.latitude;
		workingPosition.longitude = route.waypoints[i].position.longitude;
		var sentence = "$" + sender + "WPL," + workingPosition.NMEA + "," + route.waypoints[i].markName;
		output(sentence); 
		}
	if (trace) printOrange("WPTs sent\n");
	if (onlyGoto) return;	// Don't need to send an actual route
	// now we build an array of lists of routepoints to go in each RTE sentence as space permits
	// This is tricky because the space in a sentence is limited and how many waypooints can be packed into one sentence
	// depends on the length of the route name and the waypoint names.
	// so we build a list of waypoint names and then feedthem into RTE sentences
	available = 79 - 15 - route.name.length - 3;  // space available in RTE for routepoint names
	spaceLeft = available;
	var wpLists = []; // create our array of arrays of names to go in an RTE sentence
	listIndex = 0;
	wpLists[listIndex] = "";
	for (var i = 0; i < route.waypoints.length; i++){
		wpName = clean(route.waypoints[i].markName);
		wpNameLength = wpName.length;
		if (spaceLeft >= wpNameLength){	// can fit in
			wpLists[listIndex] += (wpName + ",");
			spaceLeft -= (wpNameLength+1);	//allow for comma
			continue;
			}
		else{
			// no more space in this one
			wpLists[listIndex] = wpLists[listIndex].slice(0,-1);  // drop trailing comma
			wpLists.push("");  // new array member starts empty
			listIndex += 1; spaceLeft = available;
			i -= 1; // don't forget this last routepoint still to be fitted in next time
			}
		}
	// we may have a trailing comma after last one
	lastOne = wpLists[listIndex];
	lastChar = lastOne.charAt(lastOne.length - 1);
	if (lastChar == ",") lastOne = lastOne.slice(0,-1); // drop it
	wpLists[listIndex] = lastOne;
	arrayCount = wpLists.length;
	for (i in wpLists) { // send out the RTE sentences
		sentence = "$" + sender + "RTE," + arrayCount + "," + (i*1+1) + ",c," + route.name + "," + wpLists[i];
		output(sentence);
		}	
	}

function deactivate(){
	activeRouteGUID = startPoint = activeWaypointGUID = previousWaypoint = onlyGoto = false;
	}

function output(sentence){
	if (log) print(sentence, "*", NMEA0183checksum(sentence), "\n");
	if (send){
		for (var h = 0; h < handles.length; h++){	// some ports may not be connected to
			var notification = "";
			if (portActive[h] == -1) return;	// don't send if we have already found connection lost
			try {
				OCPNpushNMEA0183(sentence, handles[h]);
				if (adviseTime && (portActive[h] < 1))  { notification = ports[h].toString() + " connected"};
				portActive[h] = 1;
				}
			catch (err){
				if (adviseTime && (portActive[h] > 0)) notification =  ports[h].toString() + " disconnected";
				portActive[h] = -1;
				}
			if (notification != "") advise(notification);
			}
		}
	}

function clean(input, maxLength) { // purge input string of troublesome characters that screw up NMEA sentences
	nasties = ",() +:"; //chars to drop - including space
	var output = "";
	for (var i = 0; i < input.length; i++){
		ch = input[i];
		found = nasties.indexOf(ch);
		if (found < 0) output += ch;
		}
	output = output.slice(0,maxLength);
	return output;
	}

function advise(text){
	if (adviseTime == 0) return;
	alert(text);
	if (adviseTimer != 0) onSeconds(adviseTimer);	// cancel existing timer, if any
	adviseTimer = onSeconds(clearAdvise, adviseTime);
	}

function clearAdvise(){
	alert(false);
	}

function makeRoutePointsUnique(route){
	function makeUnique(name){
		for (var i = 0; i < names.length; i++){
			if (names[i]== name){
				name += "_" + suffix++;
				names.push(name);
				return name;
				}
			}
		names.push(name);
		return name;
		}
	names = [];
	suffix = 1;
	for (var p = 0; p <route.waypoints.length; p++){
		route.waypoints[p].markName = makeUnique(route.waypoints[p].markName);
		}
	}