#!/usr/bin/env bash
# auth-phase4-walk.sh — auth-rls Phase 4: the chat path, over HTTP, against a
# running `pnpm dev`. Run it twice: with SUPABASE_SERVICE_ROLE_KEY set, then
# with it unset in the web process. The chat lines must match (Phase 4's
# done-when). Only the admin-key login is expected to change.
#
#   bash plan/auth-phase4-walk.sh [base-url]
set -u
BASE="${1:-http://localhost:3000}"
# Written the way a guest would, as the eval's tool cases are ("10 October
# 2026"). Given an ISO date the model asked "Which date do you mean?" and
# called no tool (observed on the first run), which tests the prompt, not auth.
FREE_DATE=$(node -e "const d=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Manila'}));d.setDate(d.getDate()+40);console.log(d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'}))")

line() { printf '\n--- %s\n' "$1"; }

line "GET /t/villa (page: tenant_public + branding + countDocuments, as a chat token)"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/t/villa"

line "GET /t/nope (no such tenant)"
curl -s -o /dev/null -w "%{http_code}\n" "$BASE/t/nope"

line "POST /api/t/villa/chat, JSON: a documents question"
R=$(curl -s -X POST "$BASE/api/t/villa/chat" -H 'Content-Type: application/json' -d '{"message":"How many cars can park at the resort?"}')
echo "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.error){console.log('ERROR',j.error);return}console.log('reply:',j.reply.slice(0,140));console.log('sources:',j.sources.length,'from',[...new Set(j.sources.map(x=>x.documentTitle))].join('; '));console.log('conversationId:',j.conversationId)})"
CONV=$(echo "$R" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).conversationId||'')}catch{console.log('')}})")

line "GET /api/t/villa/conversations/<id>/messages (the transcript)"
curl -s "$BASE/api/t/villa/conversations/$CONV/messages" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.error?('ERROR '+j.error):(j.length+' messages: '+j.map(m=>m.role).join(',')))})"

line "GET /api/t/northwind/conversations/<villa's id>/messages (cross-tenant)"
curl -s -w " [%{http_code}]\n" "$BASE/api/t/northwind/conversations/$CONV/messages"

line "POST /api/t/villa/chat, JSON: availability on $FREE_DATE (the tool, on a chat token)"
curl -s -X POST "$BASE/api/t/villa/chat" -H 'Content-Type: application/json' -d "{\"message\":\"Is the villa free on $FREE_DATE?\"}" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(j.error){console.log('ERROR',j.error);return}console.log('reply:',j.reply.slice(0,160));console.log('tool calls:',(j.toolCalls||[]).map(t=>t.name+' '+(Array.isArray(t.result)?t.result.length+' rows, '+[...new Set(t.result.map(r=>r.status))].join('/'):JSON.stringify(t.result).slice(0,80))).join('; ')||'none')})"

line "POST /api/t/northwind/chat, JSON: a villa fact (the leak case)"
curl -s -X POST "$BASE/api/t/northwind/chat" -H 'Content-Type: application/json' -d '{"message":"How many cars can park at the resort?"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.error?('ERROR '+j.error):('reply: '+j.reply+' | sources: '+j.sources.length))})"

line "POST /api/t/villa/chat, SSE: event names in order"
curl -s -N -X POST "$BASE/api/t/villa/chat" -H 'Content-Type: application/json' -H 'Accept: text/event-stream' -d '{"message":"Is there Wi-Fi?"}' | grep '^event:' | uniq -c | awk '{print $1"x "$3}' | tr '\n' ' '; echo

line "POST /api/t/villa/admin/session with a wrong key (the admin-key login: the one exception)"
curl -s -w " [%{http_code}]\n" -X POST "$BASE/api/t/villa/admin/session" -H 'Content-Type: application/json' -d '{"key":"not-the-key"}'
