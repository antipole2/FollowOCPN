// user options
const ports = [60002, 60003];	// The output ports to offer
const navUpdatePeriod = 5;	// navigation data update period in seconds
const courseUpdatePeriod = 10;	// course data update period in seconds
const adviseTime = 7;			// seconds to display notifications.  Set to false to supress
const uniqueNames = true;		// uniquify routepoint names within route

// debugging settings
log = false;	// print to output window as well as file
send = true;	// whether to send NMEA output to the ports - normally true
trace = false;

require("pluginVersion")("3.1.1");

// Declarations in outermost scope
const scriptName = "FollowOCPN";
const scriptVersion = 1.1
consoleName(scriptName);
const sender = "FO";	// NMEA0183 sender ID for generated sentences
var courseActive = false;
var adviseTimer = 0;	// timer id
var activeWaypointGUID = false;
var lastActiveWaypointGUID = false;	// the waypoint before the active leg
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
onAllSeconds(updateNav, navUpdatePeriod);
onAllSeconds(updateCourse, courseUpdatePeriod);
OCPNonAllNMEA0183(handleMWV, "MWV");
// that's it - the functions do the rest

function handleMWV(message){
	if (!message.OK) return;	// ignore if bad checksum
	if (log) print(message.value, "\n");
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
	// if stationary, COG and HDG might not be valid numbers - avoid including them.
	if (!isNaN(navData.COG)){
		sentence = "$" + sender + "VTG," + navData.COG + ",T,,M," + navData.SOG + ",N,,K,A";
		output(sentence);
		}
	if (!isNaN(navData.HDM)){
		sentence = "$" + sender +"HDG," + navData.HDM + ",,,"  + Math.abs(navData.variation) + "," + ((navData.variation < 0)?"W":"E");
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
	if (trace) print("Ending updateNav\n");
	}

function updateCourse(){
	if (trace) print("Entered updateCourse\n");
	activeWaypointGUID = OCPNgetActiveWaypointGUID();
	if (!activeWaypointGUID){
		if (lastActiveWaypointGUID) advise("Course deactivated");
		lastActiveWaypointGUID = false;
		return;
		}
	if (activeWaypointGUID != lastActiveWaypointGUID){
		advise("Activated mark " + OCPNgetSingleWaypoint(activeWaypointGUID).markName);
		lastActiveWaypointGUID = activeWaypointGUID;
		}
	activeRouteGUID = OCPNgetActiveRouteGUID();
	if (!activeRouteGUID){
		courseActive = false
		return;
		}
	route = OCPNgetRoute(activeRouteGUID);
	if (route.name == "") route.name = "undefined";	// avoid empty route name
	// route might have names with characters incompatible with NMEA0183 - clean up
	route.name = clean(route.name);
	for (var p = 0; p < route.waypoints.length; p++) route.waypoints[p].markName = clean(route.waypoints[p].markName);
	var navData = OCPNgetNavigation();
	if (activeWaypointGUID == route.waypoints[0].GUID){
		// active point is 1st in route, so not reached first
		if (trace) print("Active waypoint is 1st in route\n");
		startWaypoint = {position: navData.position, markName:"Start"};	// waypoint whre we are
		route.waypoints.unshift(startWaypoint);	// add to front of route
		}
	makeRoutePontsUnique(route);
	sendRoute(route);
	OCPNonActiveLeg();	// cancel any outstanding
	OCPNonActiveLeg(sendRMB);
	if (trace) print("Ending updateCourse\n");
	}

function sendRMB(leg){
	if (trace) print("Starting in sendRMB\n");
	xte = leg.xte;
	activeWaypointGUID = OCPNgetActiveWaypointGUID();
	if (!activeWaypointGUID || !lastActiveWaypointGUID) return;	// cannot start yet
	var lastWaypoint = OCPNgetSingleWaypoint(lastActiveWaypointGUID);	
	var activeWaypoint = OCPNgetSingleWaypoint(activeWaypointGUID);
	fromWpName = activeWaypoint.markName;
	toWpName = leg.markName;
	here = navData.position;
	there = activeWaypoint.position;
	vector = OCPNgetVectorPP(here, there);
	angle = navData.COG - vector.bearing;
	if (angle < 0) angle += 360;
	closing = navData.SOG*Math.cos(angle * Math.PI/180);	// closing speed - degrees to radian for cos
	sentence = "$" + sender + "RMB,A," + Math.abs(xte).toFixed(2) + "," + ((xte >= 0)?"L":"R" ) + "," +
		lastWaypoint.markName + "," + toWpName + "," + new Position(activeWaypoint.position).NMEA + "," +
		vector.distance.toFixed(2) + "," + vector.bearing.toFixed(1) + "," + closing.toFixed(2) + "," + (leg.arrived?"A":"V");
	output(sentence);
	// now the BOD - origin to destination
	sentence = "$" + sender + "BOD," + leg.bearing.toFixed(2) + ",T,0,M," + toWpName+ "," + lastWaypoint.markName;
	output(sentence);
	if (trace) print("Done in sendRMB\n");
	}
	

function sendRoute(route){	// sends out WPT and RTL sentences
	// we work through the route points, sending out WPL sentences and noting which is the next and last
	if (trace) print("Route: ", route, "\n");
	for (var i = 0; i < route.waypoints.length; i++){// push out the WPT sentences
		workingPosition.latitude = route.waypoints[i].position.latitude;
		workingPosition.longitude = route.waypoints[i].position.longitude;
		var sentence = "$" + sender + "WPL," + workingPosition.NMEA + "," + route.waypoints[i].markName;
		output(sentence); 
		}
	if (trace) print("WPTs sent\n");
	// now we build an array of lists of routepoints to go in each RTE sentence as space permits
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

function output(sentence){
	if (log) print(sentence, "\n");
	if (send){
		for (var h = 0; h < handles.length; h++){	// some ports may not be connected to
			var notification = "";
			if (portActive[h] == -1) return;	// don't send if we have already found connection lost
//print("About to output h:", h, "\n");
			try {
				OCPNpushNMEA0183(sentence, handles[h]);
//print("Port ", h," OK\n");
				if (adviseTime && (portActive[h] < 1))  { notification = ports[h].toString() + " connected"};
				portActive[h] = 1;
				}
			catch (err){
//print("Port ", h," failed\n");
				if (adviseTime && (portActive[h] > 0)) notification =  ports[h].toString() + " disconnected";
				portActive[h] = -1;
				}
			if (notification != "") advise(notification);
			}
		}
	}

function clean(input) { // purge input string of troublesome characters that screw up NMEA sentences
	nasties = ",() +"; //chars to drop - including space
	var output = "";
	for (i = 0; i < input.length; i++){
		ch = input[i];
		found = nasties.indexOf(ch);
		if (found < 0) output += ch;
		}
	if (output.length > 8) output = output.slice(0,7);
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

function makeRoutePontsUnique(route){
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
