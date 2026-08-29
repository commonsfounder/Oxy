'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ACTION_CONTRACTS, buildToolsForGemini } = require('../../api/action-contracts');
const { TASKS } = require('../dev/real-user-task-matrix');

test('contextual reminders are part of the general scheduled-task capability', () => {
  const contract = ACTION_CONTRACTS.create_scheduled_task;
  assert.ok(contract.optional.includes('context_event'));
  assert.ok(contract.optional.includes('context_metric'));
  assert.ok(contract.optional.includes('context_radius_metres'));
  assert.match(contract.guidance, /remind me to take the parcel when I get home/);
  assert.match(contract.guidance, /fires only on a real transition/);
  assert.match(contract.guidance, /Never use it for another household member/);
  assert.match(contract.guidance, /Never invent a medical threshold/);
});

test('native tool declarations expose the bounded context-event vocabulary', () => {
  const declaration = buildToolsForGemini(false)[0].functionDeclarations
    .find(item => item.name === 'create_scheduled_task');
  assert.ok(declaration);
  assert.match(declaration.parameters.properties.context_event.description, /arrive_home \| leave_home/);
  assert.match(declaration.parameters.properties.context_metric.description, /resting_heart_rate/);
});

test('the real-user acceptance corpus keeps the contextual household behavior visible', () => {
  const task = TASKS.find(item => item.id === 'contextual-reminder');
  assert.equal(task?.expectedAction, 'create_scheduled_task');
  assert.match(task?.message || '', /when I get home/);
  const healthTask = TASKS.find(item => item.id === 'health-threshold-watch');
  assert.equal(healthTask?.expectedAction, 'create_scheduled_task');
  assert.match(healthTask?.message || '', /resting heart rate/);
});

test('the proactive runtime has no universal hardcoded heart-rate alert', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../api/index.js'), 'utf8');
  assert.doesNotMatch(source, /maybeCreateHealthAlert/);
  assert.doesNotMatch(source, /proactive\.health\.low_hr/);
  assert.match(ACTION_CONTRACTS.create_scheduled_task.guidance, /threshold to the number the user named/);
});

test('iOS refreshes native context from HealthKit events with source timestamps', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../../OxyApp/OxyApp/Services/NativeIntegrationManager.swift'),
    'utf8'
  );
  assert.match(source, /HKObserverQuery/);
  assert.match(source, /enableBackgroundDelivery/);
  assert.match(source, /latestHeartRateRecordedAt/);
  assert.match(source, /restingHeartRateRecordedAt/);
  assert.match(source, /await self\.syncNativeContext/);
  const plist = fs.readFileSync(path.join(__dirname, '../../OxyApp/OxyApp/Info.plist'), 'utf8');
  assert.match(plist, /run health watches you create/);
  assert.match(plist, /<string>location<\/string>/);
});
