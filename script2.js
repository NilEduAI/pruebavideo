// --- Elementos del DOM ---
const videoWrapper = document.getElementById('youtube-player');
const questionOverlay = document.getElementById('question-overlay');
const questionText = document.getElementById('question-text');
const answersContainer = document.getElementById('answers-container');
const feedback = document.getElementById('feedback'); // El párrafo de feedback bajo las respuestas
const submitButton = document.getElementById('submit-answer');
const resetButton = document.getElementById('reset-progress'); // Botón de reiniciar en el overlay
const progressBar = document.getElementById('progress-bar');
const progressTextSrOnly = document.getElementById('progress-text'); // Para lectores de pantalla
const reviewSection = document.getElementById('review-section');
const reviewContent = document.getElementById('review-content'); // Contenedor para items de revisión
const restartVideoButton = document.getElementById('restart-video'); // Botón de reiniciar en la sección de revisión

// --- Variables Globales ---
let player; // Instancia del reproductor de YouTube
let questions = []; // Almacena las preguntas cargadas
let currentQuestionIndex = 0; // Índice de la pregunta actual (checkpoint actual)
let userAnswers = []; // Almacena las respuestas del usuario para revisión
let currentQuestionData = null; // Almacena la pregunta actualmente mostrada
let isQuestionActive = false; // Bandera para saber si una pregunta está siendo mostrada

// Claves para localStorage
const LOCAL_STORAGE_KEY_PROGRESS = 'videoInteractiveProgress';
const LOCAL_STORAGE_KEY_ANSWERS = 'videoInteractiveAnswers';

// Internacionalización (locale)
let currentLocale = {};
const DEFAULT_LANG = 'es';
const LOCALES_PATH = './locales/';

// --- Funciones de Utilidad ---

/**
 * Aleatoriza un array usando el algoritmo de Fisher-Yates.
 * @param {Array} array El array a aleatorizar.
 * @returns {Array} El array aleatorizado.
 */
function shuffleArray(array) {
    const shuffledArray = [...array]; // Crear una copia para no modificar el original
    for (let i = shuffledArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
    }
    return shuffledArray;
}

/**
 * Carga las cadenas de texto para internacionalización.
 * @param {string} lang El código del idioma (ej. 'es').
 */
async function loadLocale(lang = DEFAULT_LANG) {
    try {
        const response = await fetch(`${LOCALES_PATH}${lang}.json`);
        if (!response.ok) {
             throw new Error(`HTTP error! status: ${response.status}`);
        }
        currentLocale = await response.json();
        console.log(`Locale '${lang}' loaded successfully.`);
        applyLocalization();
    } catch (error) {
        console.error(`Error al cargar el archivo de idioma '${lang}.json':`, error);
        // Fallback: usar claves como texto si la carga falla
        currentLocale = {}; // Clear potentially partial loaded data
        applyLocalization(); // Attempt to apply with empty locale (will show keys)
    }
}

/**
 * Aplica las cadenas de texto del idioma actual a los elementos del DOM.
 */
function applyLocalization() {
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.dataset.i18n;
        if (currentLocale[key]) {
            element.textContent = currentLocale[key];
        } else {
             // Optional: Show key if translation is missing
             // element.textContent = `[${key}]`;
        }
    });
     // Update ARIA label for progress bar separately if needed
     // Example: progressTextSrOnly's textContent is updated in updateProgressBar
}

/**
 * Obtiene una cadena de texto localizada.
 * @param {string} key La clave de la cadena.
 * @param {object} [replacements] Objeto con reemplazos para el texto.
 * @returns {string} La cadena de texto localizada o la clave si no se encuentra.
 */
function getLocalizedText(key, replacements = {}) {
    let text = currentLocale[key] || key; // Fallback a la clave si no se encuentra la traducción
    for (const placeholder in replacements) {
        const regex = new RegExp(`\\{${placeholder}\\}`, 'g'); // Usar regex global para todos los reemplazos
        text = text.replace(regex, replacements[placeholder]);
    }
    return text;
}


// --- Funciones de la API de YouTube ---

// Esta función es llamada por la API de YouTube Player después de cargar.
// DEBE tener este nombre.
function onYouTubeIframeAPIReady() {
    console.log('API de YouTube IFrame lista. Creando reproductor.');
    player = new YT.Player('youtube-player', {
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
}

/**
 * Se ejecuta cuando el reproductor de YouTube está listo.
 */
function onPlayerReady(event) {
    console.log('Reproductor de YouTube listo. ID:', event.target.getVideoData().video_id);
    // Ahora que el reproductor está listo, cargamos el progreso y empezamos la lógica.
    loadProgress();
    // Forzar una pausa inicial para que el usuario inicie la reproducción manualmente
    // o esperar a que el script lo controle si hay progreso guardado.
    player.pauseVideo();

    // Después de cargar el progreso, iniciamos la verificación de tiempos
    checkQuestionTiming();
}

/**
 * Se ejecuta cuando el estado del reproductor de YouTube cambia.
 * @param {object} event El evento de cambio de estado. data es el código de estado.
 *   -1: Unstarted
 *    0: Ended
 *    1: Playing
 *    2: Paused
 *    3: Buffering
 *    5: Cued
 */
function onPlayerStateChange(event) {
    console.log('Estado del reproductor:', event.data);
    // Si el video está reproduciéndose, asegurar que la verificación de tiempos está activa.
    if (event.data === YT.PlayerState.PLAYING) {
        // Reiniciar el intervalo de verificación solo si no hay una pregunta activa
        if (!isQuestionActive) {
             checkQuestionTiming();
        }
    } else {
        // Si el video no está reproduciéndose (pausado, cued, ended, etc.),
        // detener el intervalo de verificación para no consumir recursos innecesariamente.
        // EXCEPTO si la pausa es porque se mostró una pregunta (isQuestionActive es true).
        if (!isQuestionActive) {
             clearInterval(questionCheckInterval);
             questionCheckInterval = null; // Resetear la variable
        }
    }

    // Si el video ha terminado completamente, mostrar la sección de revisión
    if (event.data === YT.PlayerState.ENDED) {
        console.log('Video terminado. Mostrando revisión.');
        showReviewSection();
         clearInterval(questionCheckInterval); // Asegurar que no haya intervalo activo
         questionCheckInterval = null;
    }
}

/**
 * Comprueba si es el momento de la siguiente pregunta y la muestra.
 * Se llama periódicamente mientras el video se reproduce.
 */
let questionCheckInterval = null; // Variable para almacenar el ID del intervalo
function checkQuestionTiming() {
     // No iniciar un nuevo intervalo si ya hay uno activo y no estamos en una pregunta
     if (questionCheckInterval !== null && !isQuestionActive) {
         return;
     }
     // Si hay una pregunta activa, no iniciar el intervalo
     if (isQuestionActive) {
         if (questionCheckInterval) clearInterval(questionCheckInterval);
         questionCheckInterval = null;
         return; // No verificar tiempo mientras se responde
     }


    // Limpiar cualquier intervalo anterior antes de iniciar uno nuevo
    if (questionCheckInterval) {
        clearInterval(questionCheckInterval);
    }

    questionCheckInterval = setInterval(() => {
        // Solo verificar si el reproductor existe, la API está lista y hay preguntas pendientes
        if (player && player.getCurrentTime && currentQuestionIndex < questions.length) {
            const currentTime = player.getCurrentTime();
            const nextQuestion = questions[currentQuestionIndex];

            // Verificar si el tiempo actual alcanza o supera el tiempo de la siguiente pregunta
            // y si no hay ya una pregunta activa.
            if (currentTime >= nextQuestion.time && !isQuestionActive) {
                console.log(`Tiempo alcanzado: ${currentTime}s. Mostrando pregunta ${currentQuestionIndex + 1}.`);
                player.pauseVideo(); // Pausar el video
                isQuestionActive = true; // Establecer la bandera
                displayQuestion(nextQuestion); // Mostrar la pregunta
                clearInterval(questionCheckInterval); // Detener el intervalo hasta que la pregunta sea respondida
                questionCheckInterval = null; // Resetear la variable del intervalo
            }
        } else if (currentQuestionIndex >= questions.length) {
             // Si ya no hay más preguntas, detener la verificación
             console.log('Todas las preguntas respondidas o cargadas.');
             clearInterval(questionCheckInterval);
             questionCheckInterval = null;
        }
         // Note: If player.getCurrentTime is not available yet, this interval will keep running
         // until it is, or onPlayerStateChange stops it if the video pauses for other reasons.

    }, 500); // Verificar cada 500ms (0.5 segundos)
    console.log('Iniciado intervalo de verificación de tiempos.');
}

// --- Funciones de Preguntas y Respuestas ---

/**
 * Muestra una pregunta en la interfaz.
 * @param {object} question La pregunta a mostrar.
 */
function displayQuestion(question) {
    currentQuestionData = question; // Guardar la pregunta actual
    questionText.textContent = question.question;
    answersContainer.innerHTML = ''; // Limpiar respuestas anteriores
    feedback.textContent = ''; // Limpiar feedback anterior
    feedback.className = ''; // Limpiar clases de color del feedback
    submitButton.style.display = 'block'; // Mostrar el botón de enviar
    resetButton.style.display = 'none'; // Ocultar botón de reiniciar progreso en este momento

    let answers = [...question.answers]; // Crear una copia para no modificar el original en 'questions'

    if (question.randomize) {
        answers = shuffleArray(answers);
    }

    answers.forEach((answer, index) => {
        const button = document.createElement('button');
        button.textContent = answer.text;
        // Guardamos el índice ORIGINAL de la respuesta en los datos del botón
        // Esto es importante para poder verificar si la respuesta seleccionada es correcta
        // comparando con los datos originales en questions[currentQuestionIndex].answers
        button.dataset.originalIndex = question.answers.findIndex(a => a.text === answer.text && a.correct === answer.correct);

        button.classList.add('btn'); // Añadir clase base de botón
        button.classList.add('btn-answer'); // Clase específica para botones de respuesta
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.setAttribute('tabindex', '0'); // Hacer botones enfocables
        button.addEventListener('click', selectAnswer);
        answersContainer.appendChild(button);
    });

    questionOverlay.style.display = 'flex'; // Mostrar el overlay
    // Opcional: Asegurar que el foco esté en el overlay o la primera respuesta
    setTimeout(() => {
         // Intentar enfocar el primer botón de respuesta para accesibilidad
         const firstAnswerButton = answersContainer.querySelector('button');
         if(firstAnswerButton) {
             firstAnswerButton.focus();
         } else {
             // Si no hay respuestas (raro, pero posible), enfocar el título de la pregunta o el overlay
             questionOverlay.focus(); // Make overlay focusable in CSS with tabindex="-1"
         }
    }, 50); // Pequeño delay para asegurar que los elementos estén visibles
}

/**
 * Maneja la selección de una respuesta.
 * @param {Event} event El evento de clic.
 */
function selectAnswer(event) {
    const selectedButton = event.target.closest('button'); // Usa closest para asegurar que sea el botón incluso si se hace clic en el icono/span
    if (!selectedButton) return;

    // Quitar la clase 'selected' de todos los botones de respuesta y resetear aria-checked
    answersContainer.querySelectorAll('.btn-answer').forEach(btn => {
        btn.classList.remove('selected');
        btn.setAttribute('aria-checked', 'false');
        // Limpiar estilos de feedback si se reintenta
        btn.classList.remove('correct', 'incorrect');
    });

    // Añadir la clase 'selected' al botón actual y establecer aria-checked
    selectedButton.classList.add('selected');
    selectedButton.setAttribute('aria-checked', 'true');
    feedback.textContent = ''; // Limpiar feedback anterior al seleccionar nueva respuesta
    feedback.className = ''; // Limpiar clases de color del feedback
}

/**
 * Verifica la respuesta seleccionada por el usuario.
 */
function checkAnswer() {
    const selectedButton = answersContainer.querySelector('.btn-answer.selected');

    if (!selectedButton) {
        feedback.textContent = getLocalizedText('select_answer_prompt');
        // --- CORRECCIÓN: Usar clases CSS para el color ---
        feedback.className = 'incorrect'; // Añadir clase 'incorrect' para el color rojo (definida en CSS)
        // feedback.style.color = 'red'; // Alternativa simple sin clase
        return;
    }

    // Usamos el índice original guardado en el dataset para verificar con los datos originales
    const originalIndex = parseInt(selectedButton.dataset.originalIndex);
    const isCorrect = currentQuestionData.answers[originalIndex].correct;

    // Desactivar botones después de seleccionar una respuesta
    answersContainer.querySelectorAll('.btn-answer').forEach(btn => {
        btn.removeEventListener('click', selectAnswer);
        btn.disabled = true; // Deshabilitar botones
    });
    submitButton.disabled = true; // Deshabilitar botón de enviar


    // Guardar la respuesta del usuario para el modo revisión
    userAnswers.push({
        question: currentQuestionData.question,
        userAnswer: selectedButton.textContent, // El texto mostrado en el botón
        correctAnswer: currentQuestionData.answers.find(a => a.correct).text, // Buscar la respuesta correcta original
        isCorrect: isCorrect
    });
    saveProgress(); // Guardar el progreso y las respuestas

    if (isCorrect) {
        feedback.textContent = getLocalizedText('correct_feedback');
         // --- CORRECCIÓN: Usar clases CSS para el color ---
        feedback.className = 'correct'; // Añadir clase 'correct' para el color verde
        // feedback.style.color = 'green'; // Alternativa simple sin clase

        selectedButton.classList.add('correct'); // Resaltar la respuesta correcta seleccionada
        submitButton.style.display = 'none'; // Ocultar botón de enviar
        resetButton.style.display = 'none'; // Asegurar que el botón de reiniciar está oculto

        console.log('Respuesta Correcta.');

        // Avanzar a la siguiente pregunta después de un breve delay
        setTimeout(() => {
            questionOverlay.style.display = 'none'; // Ocultar overlay
            isQuestionActive = false; // Resetear la bandera de pregunta activa

            currentQuestionIndex++; // Mover al siguiente checkpoint
            updateProgressBar(currentQuestionIndex); // Actualizar barra de progreso
            saveProgress(); // Guardar el nuevo índice de progreso

            // Si aún hay preguntas, reanudar el video y la verificación de tiempos
            if (currentQuestionIndex < questions.length) {
                 player.playVideo(); // Reanudar el video
                 checkQuestionTiming(); // Reanudar la verificación de tiempos
            } else {
                // Si no hay más preguntas, mostrar la sección de revisión
                console.log('Todas las preguntas completadas.');
                showReviewSection();
            }

            // Re-habilitar botones y botón de enviar para la próxima pregunta (aunque estén ocultos)
             answersContainer.querySelectorAll('.btn-answer').forEach(btn => {
                 btn.disabled = false;
             });
             submitButton.disabled = false;

        }, 1500); // 1.5 segundos de feedback antes de continuar
    } else {
        feedback.textContent = getLocalizedText('incorrect_feedback');
         // --- CORRECCIÓN: Usar clases CSS para el color ---
        feedback.className = 'incorrect'; // Añadir clase 'incorrect' para el color rojo
        // feedback.style.color = 'red'; // Alternativa simple sin clase

        selectedButton.classList.add('incorrect'); // Resaltar la respuesta incorrecta seleccionada

        // Opcional: Permitir al usuario reintentar después de un delay (quitar incorrect/selected classes)
        // Por ahora, la respuesta incorrecta se queda resaltada hasta que seleccionen otra o acierten.
        console.log('Respuesta Incorrecta. Intentar de nuevo.');
         submitButton.disabled = false; // Re-habilitar el botón de enviar para que intenten de nuevo
         answersContainer.querySelectorAll('.btn-answer').forEach(btn => {
            btn.disabled = false; // Re-habilitar botones de respuesta
            // NO quitar selected/incorrect aquí si quieres que el usuario vea su último intento incorrecto
            // hasta que seleccione otra respuesta.
        });
    }
}

// --- Funciones de Progreso y Persistencia (localStorage) ---

/**
 * Actualiza la barra de progreso visualmente y para lectores de pantalla.
 * @param {number} completedQuestionsCount El número de preguntas completadas.
 */
function updateProgressBar(completedQuestionsCount) {
    if (questions.length === 0) {
        progressBar.style.width = '0%';
        progressTextSrOnly.textContent = getLocalizedText('progress_text_sr_only', {progress: 0});
        return;
    }
    const progress = (completedQuestionsCount / questions.length) * 100;
    progressBar.style.width = `${progress}%`;
    // Actualizar texto para lectores de pantalla y título de aria-label si aplica
    progressTextSrOnly.textContent = getLocalizedText('progress_text_sr_only', {progress: Math.round(progress)});
    // Opcional: Update aria-valuenow on progressbar element if needed
    // progressBar.setAttribute('aria-valuenow', Math.round(progress));
}

/**
 * Guarda el progreso actual (índice de pregunta) y las respuestas del usuario en localStorage.
 */
function saveProgress() {
    try {
        // Solo guardar si hay preguntas cargadas, para evitar guardar 0/vacío por error inicial
        if (questions.length > 0) {
             localStorage.setItem(LOCAL_STORAGE_KEY_PROGRESS, currentQuestionIndex.toString());
             localStorage.setItem(LOCAL_STORAGE_KEY_ANSWERS, JSON.stringify(userAnswers));
             console.log('Progreso y respuestas guardados.');
        }
    } catch (e) {
        console.error('Error al guardar en localStorage:', e);
        // Notificar al usuario si el guardado local falla
        // alert('No se pudo guardar el progreso localmente.');
    }
}

/**
 * Carga el progreso (índice de pregunta) y las respuestas del usuario desde localStorage.
 * Debe llamarse DESPUÉS de que las preguntas estén cargadas.
 */
function loadProgress() {
    try {
        // Solo intentar cargar si hay preguntas cargadas para tener un punto de referencia
        if (questions.length === 0) {
            console.warn('No se pudieron cargar las preguntas, saltando carga de progreso.');
            return;
        }

        const savedIndex = localStorage.getItem(LOCAL_STORAGE_KEY_PROGRESS);
        const savedAnswers = localStorage.getItem(LOCAL_STORAGE_KEY_ANSWERS);

        if (savedIndex !== null && !isNaN(parseInt(savedIndex, 10))) {
            const parsedIndex = parseInt(savedIndex, 10);
             // Asegurar que el índice cargado es válido (no mayor que el número total de preguntas)
             currentQuestionIndex = Math.min(parsedIndex, questions.length);

            updateProgressBar(currentQuestionIndex);
            console.log(`Progreso cargado: ${currentQuestionIndex} preguntas completadas.`);
        } else {
             console.log('No se encontró progreso guardado.');
             currentQuestionIndex = 0; // Iniciar desde el principio si no hay guardado o es inválido
             updateProgressBar(0);
        }

        if (savedAnswers) {
            try {
                userAnswers = JSON.parse(savedAnswers);
                console.log('Respuestas cargadas:', userAnswers);
            } catch (e) {
                console.error('Error parsing saved answers from localStorage:', e);
                userAnswers = []; // Resetear si los datos de respuestas están corruptos
            }
        } else {
             userAnswers = []; // Iniciar vacío si no hay respuestas guardadas
        }

        // Si ya ha completado todas las preguntas según el progreso cargado, mostrar revisión
        if (currentQuestionIndex >= questions.length && questions.length > 0) {
            console.log('Progreso indica que todas las preguntas están completadas. Mostrando revisión.');
            showReviewSection();
            // Opcional: Mover el video al final o dejarlo como está
            if (player && player.getDuration) {
                 player.seekTo(player.getDuration(), true);
            }
        } else if (currentQuestionIndex > 0 && player && player.seekTo) {
            // Si hay progreso (más de 0 preguntas completadas), intentar buscar el tiempo
            // de la última pregunta respondida para reanudar cerca de allí.
            // Esto es un poco más complejo, idealmente reanudarías en el tiempo de la PREGUNTA actual.
            // Vamos a reanudar en el tiempo de la pregunta actual (questions[currentQuestionIndex].time)
            const resumeTime = questions[currentQuestionIndex]?.time || 0; // Si el índice es questions.length, time sería undefined, usamos 0
            console.log(`Reanudando video en tiempo de la próxima pregunta: ${resumeTime}s`);
            player.seekTo(resumeTime, true);
        }
        // No llamar a playVideo() aquí; onPlayerReady o la interacción del usuario lo harán.
        // checkQuestionTiming() se llama en onPlayerReady.


    } catch (e) {
        console.error('Error general al cargar el progreso desde localStorage:', e);
        // Si hay un error general al cargar (ej. localStorage no disponible), resetear
        console.warn('No se pudo cargar el progreso desde localStorage. Iniciando desde cero.');
        resetProgress(false); // Resetear sin preguntar
    }
}

/**
 * Reinicia todo el progreso y las respuestas del usuario.
 * @param {boolean} askConfirmation Si se debe pedir confirmación al usuario.
 */
function resetProgress(askConfirmation = true) {
    if (askConfirmation) {
        if (!confirm(getLocalizedText('confirm_reset_progress', { /* sin placeholders */ }))) {
            return; // Cancelar si el usuario no confirma
        }
    }

    localStorage.removeItem(LOCAL_STORAGE_KEY_PROGRESS);
    localStorage.removeItem(LOCAL_STORAGE_KEY_ANSWERS);

    currentQuestionIndex = 0;
    userAnswers = [];
    updateProgressBar(0);

    // Reiniciar el estado de la UI
    questionOverlay.style.display = 'none';
    reviewSection.style.display = 'none';
    feedback.textContent = '';
    feedback.className = '';
    isQuestionActive = false;
    submitButton.style.display = 'block';
    resetButton.style.display = 'none'; // Ocultar este botón si no está en revisión

    // Reiniciar el video
    if (player && player.seekTo) {
        player.seekTo(0, true); // Ir al inicio del video
        player.playVideo(); // Empezar a reproducir
        checkQuestionTiming(); // Reanudar la verificación de tiempos
    } else {
         // Si el player no está listo, la verificación se iniciará en onPlayerReady
         console.warn("Player no está listo para reiniciar el video.");
    }

    console.log('Progreso reiniciado.');
}


// --- Modo de Revisión ---

/**
 * Muestra la sección de revisión con las respuestas del usuario.
 */
function showReviewSection() {
    questionOverlay.style.display = 'none'; // Asegurarse de que el overlay de preguntas esté oculto
    reviewSection.style.display = 'block';
    if (player && player.pauseVideo) {
        player.pauseVideo(); // Asegurarse de que el video esté pausado
    }


    reviewContent.innerHTML = ''; // Limpiar contenido anterior

    if (userAnswers.length === 0) {
        // Si el usuario llegó al final sin responder preguntas (raro), mostrar mensaje.
        // O si hay preguntas cargadas pero ninguna respuesta.
        const message = questions.length > 0
            ? getLocalizedText('no_answers_yet_with_count', {count: questions.length})
            : getLocalizedText('no_questions_loaded');

        reviewContent.innerHTML = `<p>${message}</p>`;
        // Mostrar botón de reiniciar si no hay respuestas
         resetButton.style.display = 'block';
         return;
    }

    // --- CORRECCIÓN: Asegurar que la clase incorrect se añade al contenedor del item ---
    // Los estilos CSS usarán .review-item.correct .feedback-text o .review-item.incorrect .feedback-text
    userAnswers.forEach((item, index) => {
        const reviewItem = document.createElement('div');
        reviewItem.classList.add('review-item');

        // Añadir la clase 'correct' o 'incorrect' al contenedor principal del item de revisión
        if (item.isCorrect) {
            reviewItem.classList.add('correct');
        } else {
            reviewItem.classList.add('incorrect');
        }

        // --- CORRECCIÓN: NO usar style="color: var(...)" en la plantilla literal ---
        // El color del feedbackText se maneja por las clases CSS en .review-item.correct/incorrect
        reviewItem.innerHTML = `
            <p class="question-text"><strong>${getLocalizedText('question_number', {number: index + 1})}:</strong> ${item.question}</p>
            <p class="user-answer"><strong>${getLocalizedText('review_your_answer')}:</strong> ${item.userAnswer}</p>
            <p class="correct-answer"><strong>${getLocalizedText('review_correct_answer')}:</strong> ${item.correctAnswer}</p>
            <p class="feedback-text">${item.isCorrect ? getLocalizedText('review_result_correct') : getLocalizedText('review_result_incorrect')}</p>
        `;
        reviewContent.appendChild(reviewItem);
    });

    // Mostrar botón de reiniciar progreso
    resetButton.style.display = 'block';
    // Asegurarse de que el botón de reiniciar video en revisión también se muestra
     restartVideoButton.style.display = 'block'; // Asegúrate de que este botón tiene display: block en CSS si lo ocultas por defecto.
}

// --- Inicialización ---

document.addEventListener('DOMContentLoaded', async function() {
    console.log('DOM completamente cargado.');

    // Cargar el idioma primero
    await loadLocale();
     // Si quieres permitir cambiar el idioma, necesitarías botones o un selector
     // y llamar loadLocale(nuevoIdioma) y luego loadQuestions() y resetProgress() quizás.

    // Cargar preguntas desde el archivo JSON
    try {
        const response = await fetch('questions.json');
         if (!response.ok) {
             throw new Error(`HTTP error! status: ${response.status}`);
         }
        const data = await response.json();
        // Ordenar las preguntas por tiempo para asegurar el orden correcto
        questions = data.sort((a, b) => a.time - b.time);
        console.log('Preguntas cargadas y ordenadas:', questions);

        // Ahora que las preguntas están cargadas, cargar el progreso
        // loadProgress() se llama dentro de onPlayerReady, que espera la API de YouTube.
        // Pero necesitamos actualizar la barra de progreso inicial aquí si no hay progreso cargado.
        if (questions.length > 0) {
             updateProgressBar(currentQuestionIndex); // Muestra 0% o progreso cargado si loadProgress ya corrió (no debería)
        }


    } catch (error) {
        console.error('Error al cargar las preguntas:', error);
        alert(getLocalizedText('error_loading_questions')); // Usar texto localizado si es posible, sino el key
        // Si las preguntas no cargan, deshabilitar funcionalidad principal
        if (player && player.pauseVideo) player.pauseVideo();
        submitButton.disabled = true;
        resetButton.disabled = true;
        restartVideoButton.disabled = true;
         // Opcional: Mostrar un mensaje en la interfaz
         document.querySelector('.container').innerHTML += `<p style="color:red; text-align:center;">${getLocalizedText('error_loading_questions')}</p>`;

    }

    // NOTA: onYouTubeIframeAPIReady es una función global que la API de YouTube llama.
    // NO debe estar dentro de DOMContentLoaded ni ser una función local.
    // El script de la API de YouTube (<script src="https://www.youtube.com/iframe_api"></script>)
    // en el HTML se encarga de cargar la API y luego buscar y llamar a window.onYouTubeIframeAPIReady.


    // --- Asignar Eventos ---
    submitButton.addEventListener('click', checkAnswer);
    resetButton.addEventListener('click', () => resetProgress(true)); // Pedir confirmación al reiniciar desde overlay
    restartVideoButton.addEventListener('click', () => resetProgress(true)); // Pedir confirmación al reiniciar desde revisión
});

// --- Analítica Ligera (Ejemplo - Necesita tu propia implementación) ---
// Si vas a añadir analítica, asegúrate de que los scripts correspondientes
// estén en tu index.html y que llamas a las funciones de tracking (ej. trackEvent)
// en los puntos relevantes del script (respuesta correcta, incorrecta, inicio, fin, etc.).
// ¡Recuerda la privacidad y el consentimiento del usuario si es necesario!

/*
// Ejemplo de tracking en checkAnswer (después de determinar si es correcta/incorrecta)
function trackAnswer(questionId, isCorrect, userAnswer, correctAnswer) {
     // Implementa tu lógica de tracking aquí (Google Analytics, Fathom, etc.)
     console.log(`Tracking Answer: Q=${questionId}, Correct=${isCorrect}, User=${userAnswer}, Expected=${correctAnswer}`);
     // Ejemplo GA (Universal Analytics)
     // if (typeof gtag !== 'undefined') {
     //     gtag('event', 'video_question_answer', {
     //         'event_category': 'Video Interaction',
     //         'event_label': `Question ${currentQuestionIndex + 1}: ${currentQuestionData.question}`,
     //         'value': isCorrect ? 1 : 0 // 1 for correct, 0 for incorrect
     //     });
     // }
     // Ejemplo Fathom
     // if (typeof fathom !== 'undefined' && isCorrect) {
     //     // Disparar un objetivo de Fathom si la respuesta es correcta
     //     fathom.trackGoal('CODIGO_OBJETIVO_RESPUESTA_CORRECTA', 0);
     // }
}
// Llamar a trackAnswer dentro de checkAnswer después de push a userAnswers:
// trackAnswer(currentQuestionIndex + 1, isCorrect, selectedButton.textContent, currentQuestionData.answers.find(a => a.correct).text);
*/

// --- NOTA FINAL SOBRE SCORM/LTI ---
// Reiterar que esta funcionalidad NO es factible con una página estática en GitHub Pages.
// Requiere un servidor backend y/o empaquetado específico.