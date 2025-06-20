const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
const Store = require("electron-store");
const axios = require("axios");
const DependencyManager = require("./dependency-manager");

const store = new Store();

let mainWindow, browser, page, executionInterval, dailySchedule = [];

// NOVA FUNÇÃO: Retorna o caminho onde o browser DEVERIA estar
function getLocalBrowserPath() {
    return path.join(app.getPath("userData"), "browsers");
}

function setupAutoUpdater() {
    //logToUI('[INFO] Verificando atualizações...');
    autoUpdater.checkForUpdatesAndNotify();

    autoUpdater.on("update-available", () => {
        logToUI("[INFO] Nova atualização disponível. Baixando em segundo plano...");
    });

    autoUpdater.on("update-downloaded", () => {
        logToUI(
            "[SUCESSO] Atualização baixada. Ela será instalada na próxima vez que o aplicativo for reiniciado."
        );
    });

    autoUpdater.on("error", (err) => {
        logToUI("[ERRO] Erro no auto-updater: " + err.message);
    });
}

// Caminho do navegador dinamicamente
function getBrowserExecutablePath(throwOnError = true) {
    const browserPath = getLocalBrowserPath();
    const platform = process.platform;

    // CORREÇÃO: Lógica de retentativa para lidar com atrasos do sistema de arquivos
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            if (!fs.existsSync(browserPath)) {
                throw new Error("Pasta de navegadores não existe.");
            }
            const browserFolders = fs.readdirSync(browserPath);
            const chromiumFolder = browserFolders.find((folder) =>
                folder.startsWith("chromium-")
            );
            if (!chromiumFolder)
                throw new Error(
                    "Pasta específica do Chromium (ex: chromium-1178) não encontrada."
                );

            const executablePaths = {
                darwin: path.join(
                    browserPath,
                    chromiumFolder,
                    "chrome-mac",
                    "Chromium.app",
                    "Contents",
                    "MacOS",
                    "Chromium"
                ),
                win32: path.join(
                    browserPath,
                    chromiumFolder,
                    "chrome-win",
                    "chrome.exe"
                ),
                linux: path.join(browserPath, chromiumFolder, "chrome-linux", "chrome"),
            };

            // Se chegamos aqui, o caminho foi encontrado com sucesso
            return executablePaths[platform];
        } catch (error) {
            // Se for a última tentativa e ainda der erro, lança ou retorna vazio
            if (attempt === 2) {
                const userMessage = `Navegador não encontrado. (${error.message})`;
                if (throwOnError) {
                    logToUI(`[ERRO] ${userMessage}`);
                    throw new Error(userMessage);
                }
                return "";
            }
            // Aguarda 500ms antes de tentar novamente
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
        }
    }
    return ""; // Fallback
}

async function sendTelegramNotification(message) {
    const settings = store.get("telegramSettings");

    if (!settings || !settings.token || !settings.chatId) {
        logToUI(
            "[AVISO] Configurações do Telegram não encontradas. Notificação pulada."
        );
        return;
    }

    const url = `https://api.telegram.org/bot${settings.token}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: settings.chatId,
            text: message,
            parse_mode: "Markdown",
        });
        logToUI("[SUCESSO] Notificação enviada para o Telegram.");
    } catch (error) {
        logToUI(
            "[ERRO] Falha ao enviar notificação. Verifique o Token e Chat ID. Erro: " +
            error.message
        );
    }
}

async function checkBrowserHandler() {
    try {
        const executablePath = getBrowserExecutablePath(false); // Passa 'false' para não lançar erro
        return fs.existsSync(executablePath);
    } catch (error) {
        return false;
    }
}

async function downloadBrowserHandler() {
    const browserPath = getLocalBrowserPath();

    // GARANTE QUE A PASTA PAI EXISTA ANTES DO DOWNLOAD
    fs.mkdirSync(browserPath, { recursive: true });

    logToUI(
        "[INFO] Iniciando download do Chromium. Isso pode levar alguns minutos..."
    );
    const command = `cross-env PLAYWRIGHT_BROWSERS_PATH="${browserPath}" npx playwright install --with-deps chromium`;
    try {
        await execPromise(command);
        logToUI(`[SUCESSO] Navegador baixado com sucesso!`);
        return { success: true };
    } catch (error) {
        logToUI(`[ERRO] Falha ao baixar o navegador: ${error.message}`);
        return { success: false, message: error.message };
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 750,
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.webContents.on('did-finish-load', async () => {
        const nodePath = await DependencyManager.findNodeExecutable();
        if (!nodePath) {
            mainWindow.webContents.send('init-flow', { status: 'node-missing' });
            return;
        }

        const browserExists = await checkBrowserHandler();
        if (browserExists) {
            mainWindow.webContents.send('init-flow', { status: 'login' });
        } else {
            mainWindow.webContents.send('init-flow', { status: 'download' });
            // Passa o caminho do node para a função de instalação
            const result = await DependencyManager.installBrowser(getLocalBrowserPath(), nodePath, logToUI);
            mainWindow.webContents.send('download-complete', result);
        }
    });

    mainWindow.loadFile("src/index.html");
}

app.whenReady().then(() => {
    createWindow();
    setupAutoUpdater();
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
        app.quit();
    }
});

app.on("will-quit", () => {
    // Garante que qualquer intervalo de monitoramento seja limpo
    if (executionInterval) {
        clearInterval(executionInterval);
    }
});

app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

// NOVO: Handlers para os controles da janela customizada
ipcMain.on("minimize-window", () => mainWindow.minimize());
ipcMain.on("maximize-window", () => {
    if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow.maximize();
    }
});

ipcMain.on('close-window', async () => {
    logToUI('[INFO] Recebida solicitação para fechar o aplicativo. Encerrando processos...');

    // 1. Limpa o intervalo de monitoramento
    if (executionInterval) {
        clearInterval(executionInterval);
        executionInterval = null;
        logToUI('[INFO] Intervalo de monitoramento limpo.');
    }

    // 2. Tenta fechar a instância do navegador Playwright de forma graciosa
    if (browser) {
        try {
            await browser.close();
            logToUI('[INFO] Navegador Playwright fechado com sucesso.');
        } catch (error) {
            logToUI(`[AVISO] Erro ao fechar o navegador Playwright: ${error.message}`);
        } finally {
            browser = null;
        }
    }

    // 3. Força o encerramento do aplicativo
    // O app.quit() irá disparar o evento 'will-quit' naturalmente.
    logToUI('[INFO] Todos os processos limpos. Encerrando o aplicativo.');
    app.quit();
});

// NOVO: Handlers para salvar e carregar o login
ipcMain.handle("get-login", () => {
    return store.get("credentials");
});
ipcMain.handle("set-login", (event, credentials) => {
    store.set("credentials", credentials);
});

// NOVO: Handlers para salvar e carregar os horários
ipcMain.handle("get-schedules", () => store.get("schedules"));
ipcMain.handle("set-schedules", (event, schedules) =>
    store.set("schedules", schedules)
);

// NOVO: Handles do Telegram
ipcMain.handle("get-telegram-settings", () => store.get("telegramSettings"));
ipcMain.handle("set-telegram-settings", (event, settings) => {
    store.set("telegramSettings", settings);
});

// NOVO: Handle para versão do App
ipcMain.handle("get-app-info", () => {
    // Acessa o package.json de forma segura
    const appVersion = app.getVersion();
    const repoInfo = require("./package.json").build.publish;
    const repoUrl = `https://github.com/${repoInfo.owner}/${repoInfo.repo}`;
    return { version: appVersion, repoUrl };
});

ipcMain.on("open-external-link", (event, url) => {
    shell.openExternal(url); // Abre o link no navegador padrão do usuário
});

// NOVO HANDLER: Verifica se o browser existe
ipcMain.handle("check-browser", checkBrowserHandler);

// NOVO HANDLER: Inicia o download do browser
ipcMain.handle("download-browser", downloadBrowserHandler);

// Função para enviar logs para a UI
const logToUI = (message) => {
    if (mainWindow) {
        mainWindow.webContents.send("log-message", message);
    }
};

// Função para aguardar e encontrar um elemento com retentativas
async function findElement(selector, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const element = await page.waitForSelector(selector, { timeout: 5000 });
            logToUI(`[SUCESSO] Elemento encontrado: ${selector}`);
            return element;
        } catch (error) {
            logToUI(
                `[AVISO] Tentativa ${i + 1
                }/${retries} falhou ao encontrar ${selector}. Tentando novamente...`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
    throw new Error(
        `Elemento ${selector} não encontrado após ${retries} tentativas.`
    );
}

// Lógica de automação principal
ipcMain.handle("start-automation", async (event, data) => {
    logToUI("[INFO] Iniciando automação...");
    const { login, senha, horarios } = data;

    try {
        const executablePath = getBrowserExecutablePath();
        browser = await chromium.launch({
            headless: true,
            executablePath: executablePath, // AQUI ESTÁ A MUDANÇA
        });
        const context = await browser.newContext();
        page = await context.newPage();

        logToUI("[INFO] Navegando para a página de login...");
        await page.goto("https://centraldofuncionario.com.br/50911");

        await findElement("#login-numero-folha");
        await page.fill("#login-numero-folha", login);
        logToUI(`[INFO] Preenchendo login: ${login}`);

        await findElement("#login-senha");
        await page.fill("#login-senha", senha);
        logToUI("[INFO] Preenchendo senha...");

        await page.click("#login-entrar");
        logToUI('[INFO] Clicando em "Entrar"...');

        await findElement("#menu-incluir-ponto");
        await page.click("#menu-incluir-ponto");
        logToUI('[INFO] Clicando no menu "Incluir Ponto"...');

        await findElement("#app-shell-desktop-content");
        await findElement("#localizacao-incluir-ponto");

        logToUI(
            "[SUCESSO] Página de registro de ponto carregada. Preparando agendamentos..."
        );

        // Passo de sincronização
        const scrapedPunches = await syncWithWebsite();

        setupAndRecalculateSchedule(horarios, scrapedPunches);

        return {
            success: true,
            message: "Automação iniciada. Monitorando horários...",
        };
    } catch (error) {
        logToUI(`[ERRO] Falha crítica na automação: ${error.message}`);
        if (browser) await browser.close();
        return { success: false, message: error.message };
    }
});

// *** NOVA LÓGICA DE AGENDAMENTO E CORREÇÃO ***

// Funções utilitárias para manipular o tempo
const parseTime = (timeStr) => {
    // 'HH:MM' -> Date object for today
    const [hours, minutes] = timeStr.split(":").map(Number);
    const date = new Date();
    date.setHours(hours, minutes, 0, 0);
    return date;
};

const formatTime = (date) => {
    // Date object -> 'HH:MM'
    return `${String(date.getHours()).padStart(2, "0")}:${String(
        date.getMinutes()
    ).padStart(2, "0")}`;
};

// *** FUNÇÃO DE SINCRONIZAÇÃO SIMPLIFICADA ***
async function syncWithWebsite() {
    logToUI("[INFO] Buscando pontos já registrados na página atual...");
    try {
        // Pega a data de hoje no formato 'DD/MM' para comparar com o site.
        const todayDateString = new Date().toLocaleDateString("pt-BR", {
            day: "2-digit",
            month: "2-digit",
        });
        logToUI(`[INFO] Sincronizando com a data de hoje: ${todayDateString}`);

        const statusSelector = '[id^="status-processamento-"]';
        await page.waitForSelector(statusSelector, { timeout: 5000 });

        // Passo 1: Scrape de todos os registros visíveis, guardando data e hora.
        const allScrapedEntries = await page.$$eval(
            statusSelector,
            (statusElements) => {
                return statusElements
                    .map((statusEl) => {
                        const timeElement = statusEl.previousElementSibling;
                        if (timeElement && timeElement.textContent) {
                            const fullText = timeElement.textContent.trim(); // Ex: "17/06 - 23:14"
                            const dateMatch = fullText.match(/\d{2}\/\d{2}/);
                            const timeMatch = fullText.match(/\d{2}:\d{2}/);

                            if (dateMatch && timeMatch) {
                                return { date: dateMatch[0], time: timeMatch[0] };
                            }
                        }
                        return null;
                    })
                    .filter(Boolean); // Remove nulos
            }
        );

        // Passo 2: Filtra a lista para manter apenas os registros de hoje.
        const todaysPunches = allScrapedEntries
            .filter((entry) => entry.date === todayDateString)
            .map((entry) => entry.time);

        // Passo 3: Ordena os horários de hoje para garantir a ordem cronológica.
        const sortedPunches = todaysPunches.sort();

        logToUI(
            `[INFO] Pontos encontrados para HOJE (${todayDateString}): ${sortedPunches.length > 0 ? sortedPunches.join(", ") : "Nenhum"
            }`
        );
        return sortedPunches;
    } catch (error) {
        if (error.name === "TimeoutError") {
            logToUI("[INFO] Nenhum ponto registrado foi encontrado na página.");
            return [];
        }
        logToUI(
            "[AVISO] Erro não crítico ao tentar sincronizar pontos: " + error.message
        );
        return [];
    }
}

function setupAndRecalculateSchedule(uiHorarios, scrapedPunches) {
    dailySchedule = []; // Reset
    const now = new Date();
    const dayNames = [
        "Domingo",
        "Segunda-Feira",
        "Terça-Feira",
        "Quarta-Feira",
        "Quinta-Feira",
        "Sexta-Feira",
        "Sábado",
    ];
    const todayName = dayNames[now.getDay()];
    const todayUISchedules = uiHorarios[todayName];

    if (!todayUISchedules || todayUISchedules.desativado) {
        logToUI(
            `[INFO] Dia (${todayName}) desativado no app. Nenhuma ação será tomada.`
        );
        return false;
    }

    // 1. Monta o cronograma IDEAL com base nos dados da UI que acabaram de chegar.
    const scheduleKeys = ["entrada1", "saida1", "entrada2", "saida2"];
    scheduleKeys.forEach((key) => {
        if (todayUISchedules[key]) {
            dailySchedule.push({
                id: key,
                time: todayUISchedules[key],
                punched: false,
            });
        }
    });

    if (dailySchedule.length === 0) {
        logToUI("[INFO] Nenhum horário definido na UI para hoje.");
        return false;
    }

    logToUI(
        `[INFO] Cronograma ideal do app (UI): ${dailySchedule
            .map((p) => p.time)
            .join(", ")}`
    );

    // 2. Sincroniza com os pontos já batidos
    let lastPunchedTimeStr = null;
    let lastPunchedIndex = -1;

    scrapedPunches.forEach((scrapedTime, index) => {
        if (dailySchedule[index]) {
            dailySchedule[index].punched = true;
            dailySchedule[index].time = scrapedTime;
            lastPunchedTimeStr = scrapedTime;
            lastPunchedIndex = index;
            logToUI(
                `[INFO] Ponto sincronizado: ${dailySchedule[index].id} foi registrado às ${scrapedTime}.`
            );
        }
    });

    // 3. Recalcula os horários FUTUROS usando a lógica de DELTA
    if (lastPunchedTimeStr) {
        logToUI(
            `[INFO] Recalculando horários futuros com base no último ponto: ${lastPunchedTimeStr}.`
        );

        // Pega o último ponto que foi sincronizado
        const lastPunchedPoint = dailySchedule[lastPunchedIndex];

        // BUG FIX: Pega o horário IDEAL do ponto de âncora (vindo da UI), não o horário já sincronizado.
        const idealAnchorTimeStr = todayUISchedules[lastPunchedPoint.id];

        const realAnchorTime = parseTime(lastPunchedTimeStr);
        const idealAnchorTime = parseTime(idealAnchorTimeStr);

        // LÓGICA CORRETA: Calcula a diferença em milissegundos entre o real e o planejado.
        const delta = realAnchorTime.getTime() - idealAnchorTime.getTime();

        logToUI(
            `[INFO] Diferença calculada (delta): ${Math.round(
                delta / 60000
            )} minutos.`
        );

        // Aplica o mesmo delta a todos os horários futuros
        for (let i = lastPunchedIndex + 1; i < dailySchedule.length; i++) {
            const futurePoint = dailySchedule[i];
            const idealFutureTime = parseTime(futurePoint.time); // O "time" aqui ainda é o ideal da UI

            const newTime = new Date(idealFutureTime.getTime() + delta);
            const oldTime = futurePoint.time;
            futurePoint.time = formatTime(newTime);

            logToUI(
                `[INFO] Horário de ${futurePoint.id} recalculado de ${oldTime} para ${futurePoint.time}.`
            );
        }
    }

    // 4. Inicia o monitoramento se houver pontos futuros
    const nextPunch = dailySchedule.find((p) => !p.punched);
    if (nextPunch) {
        logToUI(
            `[SUCESSO] Sincronização concluída. Próximo ponto a monitorar: ${nextPunch.id} às ${nextPunch.time}.`
        );
        if (executionInterval) clearInterval(executionInterval);
        executionInterval = setInterval(monitorAndExecutePunches, 20000);
        return true;
    } else {
        logToUI(
            "[INFO] Sincronização concluída. Todos os pontos do dia já foram registrados."
        );
        return false;
    }
}

async function monitorAndExecutePunches() {
    const nextPunch = dailySchedule.find((p) => !p.punched);
    if (!nextPunch) {
        clearInterval(executionInterval);
        executionInterval = null;
        return;
    }

    if (new Date() >= parseTime(nextPunch.time)) {
        logToUI(
            `[EXECUÇÃO] Hora de bater o ponto: ${nextPunch.time} (${nextPunch.id})...`
        );
        try {
            await page.click("#localizacao-incluir-ponto");
            const actualClickTime = new Date();
            nextPunch.punched = true;
            logToUI(
                `[SUCESSO] Ponto (${nextPunch.id}) registrado às ${formatTime(
                    actualClickTime
                )}.`
            );

            const notificationMessage = `✅ Ponto de *${nextPunch.id
                }* registrado com sucesso às *${formatTime(actualClickTime)}*.`;
            await sendTelegramNotification(notificationMessage);

            // CORREÇÃO: Lógica de recálculo duplicada removida daqui.
        } catch (err) {
            logToUI(
                `[ERRO] Falha ao clicar para registrar o ponto (${nextPunch.id}): ${err.message}`
            );
        }
    }
}

ipcMain.on("cancel-automation", () => {
    logToUI("[INFO] Automação cancelada pelo usuário.");
    if (executionInterval) clearInterval(executionInterval);
    executionInterval = null;
    dailySchedule = [];

    if (browser) {
        browser.close().then(() => logToUI("[INFO] Navegador fechado."));
        browser = null;
    }
});
