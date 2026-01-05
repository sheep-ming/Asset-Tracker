// @ts-nocheck
import { characters, eventSource, event_types, saveSettingsDebounced, this_chid, chat } from "../../../../script.js";
import { extension_settings, getContext } from "../../../extensions.js";
import { selected_group } from "../../../group-chats.js";

const MODULE_NAME = 'Asset-tracker';

const ASSET_PATTERNS = [
    /\{\{img::(.*?)\}\}/gi,
    /<img\s+[^>]*src=["']([^"']+)["']/gi
];

const CUSTOM_MSG_REGEX = /asset_complete\s*=\s*(["'])([\s\S]*?)\1/i;

const TRACKER_LIST_ID = '#tracker_assets_list';
const ORIGINAL_LIST_ID = '#character_assets_list';
const RESET_BTN_ID = '#tracker_reset_btn';
const TOGGLE_BTN_ID = '#tracker_toggle_enable';
const MSG_INPUT_ID = '#tracker_custom_msg_input';
const MSG_REVEAL_ID = '#tracker_msg_reveal';     
const MSG_STATUS_ID = '#tracker_msg_status';
const TOAST_TOGGLE_ID = '#tracker_toast_enable'; 

const SCAN_INTERVAL = 2000;
let scanCheckpoint = 0;
let lastServerAssetCount = -1;

function initializeSettings() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    if (!extension_settings[MODULE_NAME].characterAssets) extension_settings[MODULE_NAME].characterAssets = {};
}

function getCurrentCharacter() {
    const context = getContext();
    if (selected_group) return null; 
    return characters[this_chid];
}

function initializeCharacterAssets(characterId) {
    if (!extension_settings[MODULE_NAME].characterAssets[characterId]) {
        extension_settings[MODULE_NAME].characterAssets[characterId] = { 
            enabled: true, 
            toastEnabled: true, 
            unlocked: [], 
            cheated: [], 
            customMessage: "" 
        };
    }
    if (!Array.isArray(extension_settings[MODULE_NAME].characterAssets[characterId].unlocked)) {
        extension_settings[MODULE_NAME].characterAssets[characterId].unlocked = [];
    }
    if (!Array.isArray(extension_settings[MODULE_NAME].characterAssets[characterId].cheated)) {
        extension_settings[MODULE_NAME].characterAssets[characterId].cheated = [];
    }
    if (typeof extension_settings[MODULE_NAME].characterAssets[characterId].toastEnabled === 'undefined') {
        extension_settings[MODULE_NAME].characterAssets[characterId].toastEnabled = true;
    }
}

function getCharacterAssets(characterId) {
    initializeCharacterAssets(characterId);
    return extension_settings[MODULE_NAME].characterAssets[characterId];
}

function isCharacterAssetsEnabled(characterId) {
    if (!extension_settings[MODULE_NAME]?.characterAssets?.[characterId]) return true; 
    return extension_settings[MODULE_NAME].characterAssets[characterId].enabled;
}

function isToastEnabled(characterId) {
    if (!extension_settings[MODULE_NAME]?.characterAssets?.[characterId]) return true;
    return extension_settings[MODULE_NAME].characterAssets[characterId].toastEnabled;
}

async function fetchCharacterAssets(characterName) {
    try {
        const result = await fetch(`/api/sprites/get?name=${encodeURIComponent(characterName)}`);
        if (!result.ok) return [];
        return await result.json();
    } catch (error) {
        console.error(`[${MODULE_NAME}] 에셋 목록 가져오기 실패:`, error);
        return [];
    }
}

function extractFileNames(text) {
    if (!text || typeof text !== 'string') return [];

    const foundFiles = new Set();
    ASSET_PATTERNS.forEach(regex => {
        const cleanRegex = new RegExp(regex);
        const matches = [...text.matchAll(cleanRegex)];
        for (const match of matches) {
            if (match[1]) {
                foundFiles.add(match[1].trim());
            }
        }
    });
    return Array.from(foundFiles);
}

function scanCardForHiddenMessage() {
    const character = getCurrentCharacter();
    if (!character) return null;

    const creatorNotes = character.creator_notes || character.creatorcomment || "";
    const authorsNote = character.data?.depth_prompt_prompt || character.data?.extensions?.depth_prompt?.prompt || "";
    const charVersion = character.data?.character_version || "";
    const charNoteField = character.data?.character_note || "";

    const searchTargets = [
        charNoteField,  
        charVersion,    
        creatorNotes,   
        authorsNote,    
        character.description, 
        character.first_mes    
    ];

    const context = getContext();
    if (context && context.worldInfo && Array.isArray(context.worldInfo)) {
        context.worldInfo.forEach(entry => {
            if (entry.content) searchTargets.push(entry.content);
        });
    }

    for (const text of searchTargets) {
        if (!text || typeof text !== 'string') continue;
        const match = text.match(CUSTOM_MSG_REGEX);
        if (match && match[2]) {
            return match[2]; 
        }
    }
    return null;
}

function getActiveCompletionMessage() {
    const charId = String(this_chid);
    const savedData = getCharacterAssets(charId);

    if (savedData && savedData.customMessage && savedData.customMessage.trim() !== "") {
        return savedData.customMessage;
    }

    return scanCardForHiddenMessage();
}

async function checkCompletionAndNotify(characterId) {
    const character = getCurrentCharacter();
    if (!character) return;

    if (!isCharacterAssetsEnabled(characterId)) return;

    const charName = character.avatar.replace(/\.[^/.]+$/, '');
    const allAssets = await fetchCharacterAssets(charName);
    const myAssets = getCharacterAssets(characterId).unlocked;

    if (allAssets.length === 0) return;

    if (myAssets.length >= allAssets.length) {
        const customMsg = getActiveCompletionMessage();
        
        const toastOptions = { 
            timeOut: 10000,
            extendedTimeOut: 5000,
            tapToDismiss: true,
            closeButton: true,
            positionClass: "toast-top-center",
            preventDuplicates: true
        };

        if (customMsg) {
            showToast('info', customMsg, '🏆 히든 메시지 발견!', toastOptions);
        } else {
            showToast('info', `모든 애셋(${allAssets.length}개)을 수집했습니다!`, '🏆 100% 달성 축하합니다!', toastOptions);
        }
    }
}

async function scanChatHistory() {
    if (!chat || !Array.isArray(chat) || !getCurrentCharacter()) return;
    const charId = String(this_chid);
    if (!isCharacterAssetsEnabled(charId)) return;

    const assetsData = getCharacterAssets(charId);
    let isUpdated = false;
    let newlyFoundCount = 0;
    let lastFoundFile = "";

    let startIndex = Math.max(scanCheckpoint, chat.length - 10);
    if (startIndex < 0) startIndex = 0;

    for (let i = startIndex; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_user) continue; 

        const msgContent = msg.mes || msg.message;
        if (!msgContent) continue;

        const foundFiles = extractFileNames(msgContent);
        foundFiles.forEach(fileName => {
            if (!assetsData.unlocked.includes(fileName)) {
                assetsData.unlocked.push(fileName);
                isUpdated = true;
                newlyFoundCount++;
                lastFoundFile = fileName;
            }
        });
    }

    if (isUpdated) {
        saveSettingsDebounced();
        await loadCharacterAssets();
        
        // [수정됨] 3초(3000ms)로 시간 연장
        if (newlyFoundCount > 0 && isToastEnabled(charId)) {
            const msg = newlyFoundCount === 1 ? `${lastFoundFile} 발견!🎉` : `${newlyFoundCount}개의 새 애셋 발견!🎉`;
            showToast('info', msg, '', { timeOut: 3000, extendedTimeOut: 1500 });
        }

        await checkCompletionAndNotify(charId);
    }
}

async function syncServerAssets() {
    const character = getCurrentCharacter();
    if (!character) return;
    const charId = String(this_chid);
    if (!isCharacterAssetsEnabled(charId)) return;

    const charName = character.avatar.replace(/\.[^/.]+$/, '');
    const assets = await fetchCharacterAssets(charName);
    
    if (lastServerAssetCount !== assets.length) {
        console.log(`[${MODULE_NAME}] 파일 변경 감지됨. UI 갱신.`);
        lastServerAssetCount = assets.length;
        await loadCharacterAssets();
    }
}

async function loadCharacterAssets() {
    const character = getCurrentCharacter();
    const assetsListContainer = $(TRACKER_LIST_ID);

    if (assetsListContainer.length === 0) return;

    if (!character) {
        assetsListContainer.html('<div style="padding:20px; text-align:center; color:gray;">캐릭터를 선택해주세요.</div>');
        $(MSG_INPUT_ID).val('').hide();
        $(MSG_STATUS_ID).hide();
        $(MSG_REVEAL_ID).prop('checked', false);
        return;
    }

    const charId = String(this_chid);
    const savedData = getCharacterAssets(charId);
    const isEnabled = isCharacterAssetsEnabled(charId);
    
    $(TOGGLE_BTN_ID).prop('checked', isEnabled);
    $(TOAST_TOGGLE_ID).prop('checked', savedData.toastEnabled !== false);

    const hiddenMsg = scanCardForHiddenMessage(); 
    const manualMsg = savedData.customMessage;    
    const isRevealed = $(MSG_REVEAL_ID).is(':checked'); 

    if (hiddenMsg && !manualMsg) {
        $(MSG_STATUS_ID).text('🔒 카드에서 히든 메시지가 감지됨 (스포일러 방지 중)').show();
    } else if (manualMsg) {
        $(MSG_STATUS_ID).text('✏️ 직접 입력한 메시지 사용 중').show();
    } else {
        $(MSG_STATUS_ID).hide();
    }

    if (isRevealed) {
        $(MSG_INPUT_ID).show();
        if (!manualMsg && hiddenMsg) {
            $(MSG_INPUT_ID).val(hiddenMsg); 
        } else {
            $(MSG_INPUT_ID).val(manualMsg || "");
        }
    } else {
        $(MSG_INPUT_ID).hide();
    }

    if (assetsListContainer.children().length === 0) {
        assetsListContainer.html('<div style="padding:20px; text-align:center;">동기화 중...</div>');
    }

    const charName = character.avatar.replace(/\.[^/.]+$/, '');
    const assets = await fetchCharacterAssets(charName);
    const unlockedList = savedData.unlocked || [];
    const cheatedList = savedData.cheated || []; 

    lastServerAssetCount = assets.length;

    assetsListContainer.empty();

    if (assets.length === 0) {
        assetsListContainer.html('<div style="padding:10px; opacity:0.7;">이 캐릭터는 연결된 애셋 파일이 없습니다.</div>');
        return;
    }

    let unlockedCount = 0;
    const totalCount = assets.length;
    assets.sort((a, b) => a.path.localeCompare(b.path));

    assets.forEach(asset => {
        const fullFileName = asset.path.split('/').pop().split('?')[0];
        const isUnlocked = unlockedList.includes(fullFileName);
        const isCheated = cheatedList.includes(fullFileName); 
        
        if (isUnlocked) unlockedCount++;

        const statusClass = isUnlocked ? 'unlocked' : 'locked';
        
        let icon = '🔒';
        if (isUnlocked) {
            icon = isCheated ? '☑️' : '✅';
        }

        let clickableClass = '';
        let titleText = '';
        
        if (isEnabled) {
            if (!isUnlocked) {
                clickableClass = 'cheat-clickable'; 
                titleText = 'title="클릭하여 강제 해금 (치트)"';
            } else {
                clickableClass = 'unlock-clickable';
                titleText = 'title="클릭하여 달성 취소"';
            }
        }
        
        const cursorStyle = isEnabled ? 'cursor: pointer;' : '';

        const itemHtml = `
            <div class="asset-item ${statusClass} ${clickableClass}" data-filename="${fullFileName}" ${titleText} style="${cursorStyle}">
                <span class="asset-icon">${icon}</span>
                <span class="asset-name">${fullFileName}</span>
            </div>
        `;
        assetsListContainer.append(itemHtml);
    });

    const percent = totalCount > 0 ? Math.round((unlockedCount / totalCount) * 100) : 0;
    let statusText = isEnabled ? `📊 해금 현황: ${unlockedCount} / ${totalCount} (${percent}%)` : `⏸️ 추적 일시정지됨 (${percent}%)`;
    
    const statsHtml = `
        <div class="asset-stats-box">
            ${statusText}
        </div>
    `;
    assetsListContainer.append(statsHtml);
}

async function handleAssetClick(e) {
    const target = $(e.currentTarget);
    const fileName = target.data('filename');
    if (!fileName) return;

    const charId = String(this_chid);
    const assetsData = getCharacterAssets(charId);

    if (target.hasClass('cheat-clickable')) {
        const confirmed = confirm(`😈 치트 모드\n\n[${fileName}]\n이 애셋을 강제로 해금하시겠습니까?\n(치트로 해금된 항목은 ☑️ 아이콘으로 표시됩니다.)`);
        if (!confirmed) return;

        if (!assetsData.unlocked.includes(fileName)) assetsData.unlocked.push(fileName);
        if (!assetsData.cheated) assetsData.cheated = [];
        if (!assetsData.cheated.includes(fileName)) assetsData.cheated.push(fileName);
        
        saveSettingsDebounced();
        await loadCharacterAssets();
        await checkCompletionAndNotify(charId);
        showToast('success', `${fileName} 해금 완료!`, '치트 활성화');
    } 
    else if (target.hasClass('unlock-clickable')) {
        const confirmed = confirm(`⚠️ 달성 취소\n\n[${fileName}]\n이 애셋의 수집 기록을 삭제하시겠습니까?\n다시 잠금 상태(🔒)로 돌아갑니다.`);
        if (!confirmed) return;

        assetsData.unlocked = assetsData.unlocked.filter(name => name !== fileName);
        if (assetsData.cheated) {
            assetsData.cheated = assetsData.cheated.filter(name => name !== fileName);
        }

        saveSettingsDebounced();
        await loadCharacterAssets();
        showToast('info', `${fileName} 달성이 취소되었습니다.`);
    }
}

function handleToggleEnable() {
    const character = getCurrentCharacter();
    if (!character) return;
    const charId = String(this_chid);
    const isChecked = $(TOGGLE_BTN_ID).is(':checked');
    
    const assetsData = getCharacterAssets(charId);
    assetsData.enabled = isChecked;
    saveSettingsDebounced();

    loadCharacterAssets();

    if (isChecked) {
        scanChatHistory();
        showToast('success', '이 채팅방의 애셋 추적을 시작합니다.');
    } else {
        showToast('info', '이 채팅방의 애셋 추적을 중지합니다.');
    }
}

function handleToastToggle() {
    const character = getCurrentCharacter();
    if (!character) return;
    const charId = String(this_chid);
    const isChecked = $(TOAST_TOGGLE_ID).is(':checked');
    
    const assetsData = getCharacterAssets(charId);
    assetsData.toastEnabled = isChecked;
    saveSettingsDebounced();
}

function handleCustomMsgChange() {
    const character = getCurrentCharacter();
    if (!character) return;
    const charId = String(this_chid);
    const inputMsg = $(MSG_INPUT_ID).val();

    const assetsData = getCharacterAssets(charId);
    assetsData.customMessage = inputMsg;
    saveSettingsDebounced();
    loadCharacterAssets();
}

function handleMsgRevealChange() {
    loadCharacterAssets();
}

async function handleResetProgress() {
    const character = getCurrentCharacter();
    if (!character) return;

    const confirmed = confirm("⚠️ 경고: 현재 캐릭터의 모든 애셋 해금 기록을 초기화하시겠습니까?\n(치트 기록도 함께 초기화됩니다)");
    if (!confirmed) return;

    const charId = String(this_chid);
    const assetsData = getCharacterAssets(charId);
    
    if (chat && Array.isArray(chat)) {
        scanCheckpoint = chat.length;
    }
    
    assetsData.unlocked = [];
    assetsData.cheated = []; 
    saveSettingsDebounced();
    
    await loadCharacterAssets();
    
    showToast('info', '모든 진행도가 초기화되었습니다.', '초기화 완료');
}

async function onCharacterChanged() {
    scanCheckpoint = 0; 
    lastServerAssetCount = -1; 
    const character = getCurrentCharacter();
    if (!character) {
        await loadCharacterAssets();
        return;
    }
    
    initializeCharacterAssets(String(this_chid));
    setupOriginalExtensionSpy();
    scanChatHistory();
    await loadCharacterAssets();
}

async function onMessageReceived(data) {
    await scanChatHistory();
}

let mutationObserver = null;

function setupOriginalExtensionSpy() {
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }

    const targetNode = document.querySelector(ORIGINAL_LIST_ID);
    if (!targetNode) return;

    mutationObserver = new MutationObserver((mutationsList) => {
        loadCharacterAssets();
    });

    mutationObserver.observe(targetNode, { childList: true, subtree: true });
}

function showToast(type, message, title = '', customOptions = {}) {
    if (window.toastr) {
        const defaultOptions = { 
            preventDuplicates: true, 
            timeOut: 3000, 
            positionClass: "toast-top-center" 
        };
        const finalOptions = { ...defaultOptions, ...customOptions };
        window.toastr[type](message, title, finalOptions);
    } else {
        console.log(`[${type.toUpperCase()}] ${title}: ${message}`);
    }
}

function setupEventHandlers() {
    $(document).on('click', RESET_BTN_ID, handleResetProgress);
    $(document).on('change', TOGGLE_BTN_ID, handleToggleEnable);
    $(document).on('input', MSG_INPUT_ID, handleCustomMsgChange);
    $(document).on('change', MSG_REVEAL_ID, handleMsgRevealChange);
    $(document).on('change', TOAST_TOGGLE_ID, handleToastToggle);
    $(document).on('click', '.asset-item.cheat-clickable, .asset-item.unlock-clickable', handleAssetClick);
}

function initializeExtension() {
    console.log(`[${MODULE_NAME}] 초기화 시작...`);
    initializeSettings();

    $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`)
        .then(html => {
            $('#extensions_settings').append(html);
        })
        .catch(error => console.error(`[${MODULE_NAME}] HTML 로드 실패:`, error));

    setupEventHandlers();
    
    const initInterval = setInterval(async () => {
        const listContainer = $(TRACKER_LIST_ID);
        if (listContainer.length > 0) {
            clearInterval(initInterval);
            console.log(`[${MODULE_NAME}] UI 발견됨. 동기화 시작.`);
            await onCharacterChanged();
        }
    }, 100);

    setInterval(() => {
        scanChatHistory();   
        syncServerAssets();  
    }, SCAN_INTERVAL);

    eventSource.on(event_types.CHAT_CHANGED, onCharacterChanged);
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    
    const observerCallback = new MutationObserver(() => {
        setupOriginalExtensionSpy();
    });
    const extensionsPanel = document.querySelector('#extensions_settings');
    if (extensionsPanel) {
        observerCallback.observe(extensionsPanel, { childList: true, subtree: true });
    }

    console.log(`[${MODULE_NAME}] 초기화 로직 완료.`);
}

$(document).ready(function() {
    initializeExtension();
});