const JavaScriptObfuscator = require('javascript-obfuscator');
const minify = require('minify');
const argv = require('yargs').argv;
const fs = require('fs');
const path = require('path');

console.log( argv.output );
console.log( argv.input );


var searchFiles = function(dir, pattern) {
  // This is where we store pattern matches of all files inside the directory
  var results = [];

  // Read contents of directory
  fs.readdirSync(dir).forEach(function (dirInner) {
    // Obtain absolute path
    dirInner = path.resolve(dir, dirInner);

    // Get stats to determine if path is a directory or a file
    var stat = fs.statSync(dirInner);
    // If path is a file and ends with pattern then push it onto results
    if (stat.isFile() && dirInner.endsWith(pattern)) {
      results.push(dirInner);
    }
  });
  return results;
};



let obfuscate = async function()
{
    var files = searchFiles(argv.input, '.js'); // replace dir and pattern
                                                    // as you seem fi
    let input = argv.input;
    let output = argv.output;

    files.forEach(async function (element) {
          console.log(element); 
          let data='';
          try {  
              data = fs.readFileSync(element , 'utf8');
          } catch(e) {
              console.log('Error:', e.stack);
          }

          var obfuscationResult = JavaScriptObfuscator.obfuscate(
              data.toString(),
              {
                  log: false,
                  compact: false,
                  controlFlowFlattening: true
              }
          );

          if (!fs.existsSync(output)){
              fs.mkdirSync(output);
          }

          let out_file_name = output+'/'+path.basename(element);
          let out_file_name_tmp = output+'/tmp_'+path.basename(element);

          fs.writeFileSync(out_file_name_tmp , obfuscationResult.getObfuscatedCode(), function(err) {

              if(err) {
          	      console.log("ERROR");
                  return ;//console.log(err);
              }

              console.log(`The file ${element} was saved!`);
          });

          minify(out_file_name_tmp)
          .then(function (element) {

              fs.writeFileSync(out_file_name , element, function(err) {
                if(err) {
                    console.log("ERROR");
                    return ;//console.log(err);
                }

                console.log(`The file ${out_file_name} was saved!`);
              });

              fs.unlinkSync(out_file_name_tmp);
            })
          .catch(console.error);
    }); 
    console.log("Done");
}

obfuscate();