plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

val rendererSource = rootProject.projectDir.parentFile.resolve("renderer")
val generatedAssets = layout.buildDirectory.dir("generated/rendererAssets")

// Подпись release-сборки приходит из CI. Локально без секретов остаётся
// debug-ключ, чтобы assembleRelease не падал на пустом месте.
val releaseStoreFile = System.getenv("ANDROID_KEYSTORE_FILE")
val releaseStorePassword = System.getenv("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("ANDROID_KEY_PASSWORD")
val hasReleaseSigning = !releaseStoreFile.isNullOrBlank()
    && !releaseStorePassword.isNullOrBlank()
    && !releaseKeyAlias.isNullOrBlank()
    && !releaseKeyPassword.isNullOrBlank()

val copyRenderer by tasks.registering(Sync::class) {
    from(rendererSource)
    into(generatedAssets.map { it.dir("renderer") })
    doLast {
        val index = generatedAssets.get().dir("renderer/index.html").asFile
        val tag = "<script src=\"../android-bridge.js\"></script>"
        val html = index.readText(Charsets.UTF_8)
        if (!html.contains(tag)) {
            index.writeText(html.replace("</head>", "    $tag\n  </head>"), Charsets.UTF_8)
        }
    }
}

android {
    namespace = "ru.dndstol.player"
    compileSdk = 35

    defaultConfig {
        applicationId = "ru.dndstol.player"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "1.7.0"
    }

    buildFeatures {
        buildConfig = true
    }

    sourceSets["main"].assets.srcDir(generatedAssets)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
        freeCompilerArgs = freeCompilerArgs + listOf("-opt-in=kotlin.ExperimentalUnsignedTypes")
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(releaseStoreFile!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            signingConfig = if (hasReleaseSigning) {
                signingConfigs.getByName("release")
            } else {
                signingConfigs.getByName("debug")
            }
        }
    }

    // iroh вызывает java.lang.ref.Cleaner через Class.forName, и lint принимает
    // это за вызов нового API. Ошибка lint не должна останавливать сборку.
    lint {
        abortOnError = false
        checkReleaseBuilds = false
    }
}

tasks.named("preBuild").configure { dependsOn(copyRenderer) }

dependencies {
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // QR-сканер билета: камера и распознавание уже внутри, своя реализация
    // заняла бы сотни строк и всё равно потребовала бы ZXing.
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")

    // AAR-вариант iroh: libiroh_ffi.so под каждый ABI Android и IrohAndroid
    // для инициализации JNI. Обычный computer.iroh:iroh содержит только
    // нативные библиотеки десктопа.
    implementation("computer.iroh:iroh-android:1.2.0")
}
